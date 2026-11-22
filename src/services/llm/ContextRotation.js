/**
 * 按 token 的上下文轮换
 *
 * 超过 context.rotation.maxTokens 时：
 *   - 把旧对话压成「四栏摘要 + nextOpening」
 *   - 只保留最近 N 条原文（默认 5）
 *   - 摘要写入 kv，下一轮作为前情注入；同一条摘要只更新不追加
 */
import config from '../../../config/config.js'
import { chatLogger as logger } from '../../core/utils/logger.js'
import { databaseService } from '../storage/DatabaseService.js'

const KV_PREFIX = 'context_rotation:'

const SUMMARY_PROMPT = `把下面这段对话压缩成固定四栏，只输出这几行，不要解释、不要加标题外的内容：
主题：<一句话，不超过 30 字>
约定：<双方说定的事，没有就写“无”，不超过 40 字>
ta的状态和雷点：<对方当前情绪、在意的点，没有就写“无”，不超过 40 字>
待续：<还没聊完或答应要做的事，没有就写“无”，不超过 40 字>
nextOpening：<下一轮开口第一句怎么接，不超过 30 字，不要引号>

对话：
{dialog}`

class ContextRotation {
    cfg() {
        return config.get('context.rotation') || {}
    }

    getState(conversationId) {
        try {
            return databaseService.getKV(KV_PREFIX + conversationId) || null
        } catch {
            return null
        }
    }

    getSummaryBlock(conversationId) {
        const st = this.getState(conversationId)
        if (!st || !st.summary) return ''
        let block = `\n\n【前情摘要】\n${st.summary}`
        if (st.nextOpening) block += `\n【待续】${st.nextOpening}`
        const cap = Number(this.cfg().summaryMaxChars) || 600
        return block.length > cap ? block.slice(0, cap) + '…' : block
    }

    /**
     * 超过 token 上限就轮换；没超就直接返回已有摘要块（没有则空串）。
     */
    async maybeRotate({ conversationId, history, groupId }) {
        const cfg = this.cfg()
        const block = this.getSummaryBlock(conversationId)
        if (cfg.enabled === false) return ''
        if (!conversationId || !Array.isArray(history) || history.length === 0) return block

        const keep = Math.max(2, Number(cfg.keepRecent) || 5)
        if (history.length <= keep + 2) return block

        const textOf = m => (Array.isArray(m.content) ? m.content.map(p => p?.text || '').join('') : String(m.content || ''))
        const fullText = history.map(m => `${m.role}: ${textOf(m)}`).join('\n')
        const maxTokens = Number(cfg.maxTokens) || 75000
        // 中文约 1 token ≈ 1.5 字，先用字符粗判，避免每轮都跑 tokenizer
        if (fullText.length / 1.5 < maxTokens) return block

        globalThis.logger?.mark?.(
            `[Rotation] 触发检查：history=${history.length} chars=${fullText.length} est=${Math.round(fullText.length / 1.5)} 上限=${maxTokens}`
        )
        const oldMessages = history.slice(0, -keep)
        const dialog = oldMessages
            .map(m => `${m.role === 'assistant' ? '她' : '对方'}: ${textOf(m)}`)
            .join('\n')
            .slice(-40000)

        let text = ''
        try {
            const { delegateRequest } = await import('./LlmDelegator.js')
            const { LlmService } = await import('./LlmService.js')
            const model = cfg.model || config.get('memory.model') || undefined
            const client = await LlmService.getChatClient({ model })
            const channelInfo = client._channelInfo || {}
            const result = await delegateRequest({
                userMessage: { role: 'user', content: [{ type: 'text', text: SUMMARY_PROMPT.replace('{dialog}', dialog) }] },
                initialModel: model || channelInfo.model,
                initialChannel: channelInfo.channel || null,
                initialClient: client,
                clientBaseOptions: {},
                requestOptions: { maxToken: 500, disableHistorySave: true, temperature: 0.3 },
                event: null,
                source: '对话轮换'
            })
            try {
                const { statsService } = await import('../stats/StatsService.js')
                await statsService.recordApiCall({
                    channelId: result.usedChannel?.id || 'context-rotation',
                    channelName: result.usedChannel?.name || '对话轮换',
                    model: result.usedModel || model,
                    duration: 0,
                    success: true,
                    source: '对话轮换',
                    apiUsage: result.usage,
                    request: { messages: [{ role: 'user', content: dialog.slice(0, 200) }], model }
                })
            } catch {}
            text = (result.response?.contents || [])
                .filter(c => c.type === 'text')
                .map(c => c.text)
                .join('')
                .trim()
        } catch (err) {
            globalThis.logger?.warn?.('[ContextRotation] 摘要生成失败:', err.message)
            return block
        }

        if (!text) return block

        const nextMatch = text.match(/nextOpening[:：]\s*(.+)/i)
        const nextOpening = nextMatch ? nextMatch[1].trim().slice(0, 60) : ''
        const summary = text.replace(/nextOpening[:：].*/i, '').trim().slice(0, 500)

        try {
            databaseService.setKV(KV_PREFIX + conversationId, { summary, nextOpening, updatedAt: Date.now() })
            databaseService.trimMessages(conversationId, keep)
        } catch (err) {
            logger.warn('[ContextRotation] 写入摘要/裁剪历史失败:', err.message)
        }

        globalThis.logger?.mark?.(`[Rotation] 轮换完成：保留 ${keep} 条，摘要 ${summary.length} 字`)
        return this.getSummaryBlock(conversationId)
    }
}

export const contextRotation = new ContextRotation()
export default ContextRotation

/**
 * AI 戳一戳事件处理
 * 使用AI人设响应戳一戳
 */
import config from '../config/config.js'
import { isIgnoredBot } from '../src/utils/botFilter.js'
import { getBotIds } from '../src/utils/messageDedup.js'
import { parsePokeEvent, sendPoke, getUserNickname, checkEventProbability } from '../src/utils/eventAdapter.js'
import { getAIResponse } from '../src/utils/common.js'
import { segment } from '../src/utils/messageParser.js'
import { convertAtMentions } from '../src/utils/mentionAt.js'

/** 已拉过完整成员表的群 */
const pokeWarmedGroups = new Set()

export class AI_Poke extends plugin {
    constructor() {
        super({
            name: 'AI-Poke',
            dsc: 'AI戳一戳响应',
            event: 'notice.*.poke',
            priority: -200,
            rule: [{ fnc: 'handlePoke', log: false }]
        })
    }

    async handlePoke() {
        if (isIgnoredBot(this.e)) return false
        const e = this.e
        const pokeT0 = Date.now()
        const eventDelay = e?.time ? Date.now() - e.time * 1000 : null
        globalThis.logger?.mark?.(`[PokeTiming] 事件开始（事件→处理 ${eventDelay === null ? 'n/a' : eventDelay + 'ms'}）`)

        // 功能开关
        if (!config.get('features.poke.enabled')) {
            return false
        }

        // 事件概率检查
        const probCheck = await checkEventProbability('poke', e.group_id)
        if (!probCheck.shouldTrigger) {
            logger.debug(`[AI-Poke] 概率检查未通过: ${probCheck.reason}`)
            return false
        }

        // 使用统一事件解析
        const pokeInfo = parsePokeEvent(e)
        const { targetId, operatorId, selfId, isGroup, groupId } = pokeInfo
        const botIds = getBotIds()

        // 检查是否戳的是机器人
        if (targetId !== selfId && !botIds.has(String(targetId))) {
            return false
        }

        // 防止机器人自己触发 (回戳导致的循环)
        if (operatorId === selfId || botIds.has(String(operatorId))) {
            return false
        }

        const nickname = await getUserNickname(e, operatorId)
        globalThis.logger?.mark?.(`[PokeTiming] 昵称耗时 ${Date.now() - pokeT0}ms`)

        logger.info(`[AI-Poke] ${nickname}(${operatorId}) ${isGroup ? '群聊' : '私聊'}戳了机器人`)

        // 获取自定义提示词模板，支持占位符
        const defaultPrompt = `[事件通知] {nickname} 戳了你一下。请根据你的人设性格，给出一个简短自然的回应。`
        const promptTemplate = config.get('features.poke.prompt') || defaultPrompt
        const eventDesc = promptTemplate
            .replace(/\{nickname\}/g, nickname)
            .replace(/\{user_id\}/g, String(operatorId))
            .replace(/\{group_id\}/g, String(groupId || ''))

        const aiStartedAt = Date.now()
        const aiReply = await getAIResponse(eventDesc, {
            // 事件回复由 handler 自己发；开着工具模型会额外调 reply_current_message，一次戳一戳变成好几条消息
            disableTools: true,
            event: e,
            senderName: typeof nickname !== 'undefined' ? nickname : '',
            userId: operatorId,
            groupId: groupId,
            maxLength: 100,
            logTag: 'AI-Poke'
        })

        globalThis.logger?.mark?.(`[PokeTiming] AI耗时 ${Date.now() - aiStartedAt}ms`)
        if (aiReply) {
            // 合成事件回复也要把 @名字 转成真实 at（这条路径不走 apps/chat.js）
            // 成员表没加载过就先拉一次，否则 @名字 找不到人
            const warmPokeMembers = async () => {
                try {
                    const gid = String(groupId || '')
                    if (pokeWarmedGroups.has(gid)) return
                    const g = e?.group?.getMemberMap ? e.group : e?.bot?.pickGroup?.(gid)
                    if (typeof g?.getMemberMap !== 'function') return
                    await g.getMemberMap()
                    pokeWarmedGroups.add(gid)
                    logger.mark(`[AI-Poke] 已加载成员表 ${gid}（${e?.bot?.gml?.get?.(gid)?.size ?? e?.bot?.gml?.get?.(Number(gid))?.size ?? '?'} 人）`)
                } catch (err) {
                    logger.debug('[AI-Poke] 拉取成员失败:', err.message)
                }
            }
            await warmPokeMembers()
            const pokePayload = convertAtMentions(aiReply, { e, segment })
            const gmlSize = e?.bot?.gml?.get?.(String(groupId))?.size ?? e?.bot?.gml?.get?.(Number(groupId))?.size ?? 'null'
            logger.mark(`[AI-Poke] gml=${gmlSize} 回复片段: ${JSON.stringify(pokePayload).slice(0, 300)}`)
            const sendStartedAt = Date.now()
            await this.reply(pokePayload)
            globalThis.logger?.mark?.(`[PokeTiming] 发送耗时 ${Date.now() - sendStartedAt}ms｜总耗时 ${Date.now() - pokeT0}ms`)
            // 回戳
            if (config.get('features.poke.pokeBack') && isGroup) {
                await this.pokeBack(e, operatorId)
            }
            return true
        }

        // 默认回复
        const defaultMsg = config.get('features.poke.message') || '别戳了~'
        await this.reply(defaultMsg)
        return true
    }

    /**
     * 回戳用户 - 使用统一适配器接口
     */
    async pokeBack(e, userId) {
        try {
            const groupId = e.group_id
            if (!groupId) return

            const success = await sendPoke(e, userId, groupId)
            if (!success) {
                logger.debug('[AI-Poke] 回戳失败: 不支持的适配器或API')
            }
        } catch (err) {
            logger.debug('[AI-Poke] 回戳失败:', err.message)
        }
    }
}

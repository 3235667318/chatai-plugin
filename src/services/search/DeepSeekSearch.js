/**
 * DeepSeek Search（按需调用）
 *
 * 文档：POST https://api.deepseek.com/v1/tools/search
 * 计费：¥5 / 1000 次成功请求（只对 200 且 results 非空计费）
 */
import config from '../../../config/config.js'
import { chatLogger as logger } from '../../core/utils/logger.js'

const DEFAULT_TRIGGERS = ['搜一下', '搜搜', '查一下', '查查', '搜索', '帮我查', '找一下', '最新', '新闻']
const DEFAULT_COUNT = 4
const MAX_BLOCK_CHARS = 700
const TIMEOUT_MS = 8000

class DeepSeekSearch {
    getChannel() {
        const channels = config.get('channels') || []
        return channels.find(c => c && c.enabled !== false && c.apiKey) || channels[0] || null
    }

    async search(query, { count = DEFAULT_COUNT } = {}) {
        const ch = this.getChannel()
        if (!ch?.apiKey) return null
        const baseUrl = String(ch.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
        try {
            const res = await fetch(`${baseUrl}/tools/search`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${ch.apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: String(query).slice(0, 128), count, need_content: false }),
                signal: controller.signal
            })
            if (!res.ok) {
                logger.warn(`[DeepSeekSearch] HTTP ${res.status}`)
                return null
            }
            const data = await res.json()
            return Array.isArray(data?.results) ? data.results : []
        } catch (err) {
            logger.warn('[DeepSeekSearch] 搜索失败:', err.message)
            return null
        } finally {
            clearTimeout(timer)
        }
    }

    /**
     * 命中触发词就搜一轮，返回可直接塞进本轮上下文的文本块；没命中返回空串。
     */
    async buildContextBlock(message) {
        const cfg = config.get('tools.onDemandSearch') || {}
        if (cfg.enabled === false) return ''
        if (typeof message !== 'string' || message.length < 3) return ''

        // triggers 为空数组 = 不限制关键词，每条消息都搜；否则只在命中触发词时搜
        const triggers = Array.isArray(cfg.triggers) ? cfg.triggers : DEFAULT_TRIGGERS
        const alwaysSearch = triggers.length === 0
        const hit = alwaysSearch ? '' : triggers.find(t => t && message.includes(t))
        if (!alwaysSearch && !hit) return ''

        let query = alwaysSearch ? message : message.split(hit).join(' ')
        query = query.replace(/[\s，,。.!！?？]+/g, ' ').trim()
        if (query.length < 2) query = message.slice(0, 60)
        query = query.slice(0, 100)

        const count = Number(cfg.count) > 0 ? Number(cfg.count) : DEFAULT_COUNT
        const results = await this.search(query, { count })
        if (!results || results.length === 0) return ''

        try {
            const { statsService } = await import('../stats/StatsService.js')
            statsService.recordToolCall('deepseek_search', true)
        } catch {}

        const lines = results.slice(0, count).map((r, i) => {
            const summary = String(r.summary || r.snippet || '').replace(/\s+/g, ' ').slice(0, 140)
            const date = r.date ? `（${String(r.date).slice(0, 10)}）` : ''
            return `${i + 1}. ${r.title || '无标题'}：${summary}${date} ${r.url || ''}`
        })
        let block = `\n\n【实时搜索：${query}】\n` + lines.join('\n')
        if (block.length > MAX_BLOCK_CHARS) block = block.slice(0, MAX_BLOCK_CHARS) + '…'
        return block
    }
}

export const deepseekSearch = new DeepSeekSearch()
export default DeepSeekSearch

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
    /** 提取查询关键词：中文按 2-gram，英文按单词 */
    _queryTokens(query) {
        const text = String(query || '').toLowerCase()
        const tokens = new Set()
        const stop = new Set(['今天', '现在', '什么', '怎么', '可以', '这个', '那个', '一下', '我们', '你们', '他们'])
        for (const w of text.match(/[a-z0-9]{3,}/g) || []) tokens.add(w)
        for (const run of text.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
            if (run.length <= 4) tokens.add(run)
            for (let i = 0; i + 2 <= run.length; i++) tokens.add(run.slice(i, i + 2))
        }
        for (const s of stop) tokens.delete(s)
        return [...tokens].slice(0, 30)
    }

    async buildContextBlock(message) {
        const cfg = config.get('tools.onDemandSearch') || {}
        if (cfg.enabled === false) return ''
        if (typeof message !== 'string') return ''

        // triggers 为空数组 = 每条消息都搜；有触发词 = 只有命中关键词才搜
        const triggers = Array.isArray(cfg.triggers) ? cfg.triggers : DEFAULT_TRIGGERS
        const alwaysSearch = triggers.length === 0

        // 过短消息只在全量搜索模式下跳过；关键词模式允许“搜一下”这类短指令
        const minChars = Number(cfg.minQueryChars) > 0 ? Number(cfg.minQueryChars) : 6
        if (alwaysSearch && message.length < minChars) return ''

        const hit = alwaysSearch ? '' : triggers.find(t => t && message.includes(t))
        if (!alwaysSearch && !hit) return ''

        let query = alwaysSearch ? message : message.split(hit).join(' ')
        query = query.replace(/[\s，,。.!！?？]+/g, ' ').trim()
        if (query.length < 2) query = message.slice(0, 60)
        query = query.slice(0, 100)

        const count = Number(cfg.count) > 0 ? Number(cfg.count) : DEFAULT_COUNT
        const rawResults = await this.search(query, { count })
        if (!rawResults || rawResults.length === 0) return ''

        // 相关性过滤：查询和结果标题/摘要没有任何词重叠时，整块丢弃，避免把无关内容塞进上下文
        const queryTokens = this._queryTokens(query)
        const results = rawResults.filter(r => {
            const text = `${r.title || ''} ${r.summary || r.snippet || ''}`.toLowerCase()
            if (!text) return false
            if (queryTokens.length === 0) return true
            return queryTokens.some(t => text.includes(t))
        })
        if (results.length === 0) {
            logger.debug(`[DeepSeekSearch] 搜索结果与「${query.slice(0, 20)}」不相关，已丢弃`)
            return ''
        }

        try {
            const { statsService } = await import('../stats/StatsService.js')
            statsService.recordToolCall('deepseek_search', true)
        } catch {}

        const lines = results.slice(0, count).map((r, i) => {
            const summary = String(r.summary || r.snippet || '').replace(/\s+/g, ' ').slice(0, 140)
            const date = r.date ? `（${String(r.date).slice(0, 10)}）` : ''
            return `${i + 1}. ${r.title || '无标题'}：${summary}${date} ${r.url || ''}`
        })
        let block =
            `\n\n【实时搜索（仅作参考：与当前话题无关时忽略，不要复述或转发搜索结果）：${query}】\n` +
            lines.join('\n')
        if (block.length > MAX_BLOCK_CHARS) block = block.slice(0, MAX_BLOCK_CHARS) + '…'
        return block
    }
}

export const deepseekSearch = new DeepSeekSearch()
export default DeepSeekSearch

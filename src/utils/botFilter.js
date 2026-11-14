/**
 * Bot 过滤：忽略指定 self_id 的事件；并对同一消息被多个适配器重复投递做去重
 */
import config from '../../config/config.js'

export function ignoredBotIds() {
    const raw = config.get('basic.ignoreBots') || []
    const list = Array.isArray(raw) ? raw : String(raw).split(/[,，\s]+/)
    return list.map(id => String(id).trim()).filter(Boolean)
}

/** 跨适配器去重：QQBot 与 OneBot 同时收到同一条 @消息时，只处理先到的那条 */
const dedupeStore = globalThis.__chataiDedupe || (globalThis.__chataiDedupe = { texts: new Map(), ids: new Map() })
const recentMessages = dedupeStore.texts
const DEDUPE_WINDOW_MS = 6000

function isCrossBotDuplicate(e) {
    const raw = String(e?.msg || '').trim()
    if (!raw) return false
    // 只按“内容”去重：不同适配器给的昵称/前缀可能不同
    const normalized = raw
        .replace(/^(@\S+\s*)+/, '')
        .replace(/\[提及[^\]]*\]/g, '')
        .replace(/\s+/g, '')
        .slice(0, 80)
    if (!normalized) return false
    const now = Date.now()
    for (const [k, v] of recentMessages) {
        if (now - v.time > DEDUPE_WINDOW_MS) recentMessages.delete(k)
    }
    const prev = recentMessages.get(normalized)
    let dup = false
    if (prev && now - prev.time <= DEDUPE_WINDOW_MS) {
        dup = prev.event !== e
    } else {
        recentMessages.set(normalized, { time: now, event: e })
    }
    return dup
}

const seenMessageIds = dedupeStore.ids
const MESSAGE_ID_TTL_MS = 60 * 1000

export function isIgnoredBot(e) {
    const ids = ignoredBotIds()
    const selfId = String(e?.self_id || e?.bot?.uin || e?.bot?.info?.uin || '')
    if (selfId && ids.includes(selfId)) return true

    // 同一事件被重复处理（插件重复注册/双实例）时，message_id 相同
    const mid = e?.message_id !== undefined && e?.message_id !== null ? String(e.message_id) : ''
    if (mid) {
        const key = `${selfId}|${mid}`
        const now = Date.now()
        for (const [k, v] of seenMessageIds) {
            if (now - (v.time || v) > MESSAGE_ID_TTL_MS) seenMessageIds.delete(k)
        }
        const prev = seenMessageIds.get(key)
        if (prev && now - prev.time <= MESSAGE_ID_TTL_MS) {
            return prev.event !== e
        }
        seenMessageIds.set(key, { time: now, event: e })
    }

    return isCrossBotDuplicate(e)
}

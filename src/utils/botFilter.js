/**
 * Bot 过滤：忽略指定 self_id 的事件（例如同群同时接了 OneBot 和 QQBot 时只保留一个）
 */
import config from '../../config/config.js'

export function ignoredBotIds() {
    const raw = config.get('basic.ignoreBots') || []
    const list = Array.isArray(raw) ? raw : String(raw).split(/[,，\s]+/)
    return list.map(id => String(id).trim()).filter(Boolean)
}

export function isIgnoredBot(e) {
    const ids = ignoredBotIds()
    if (ids.length === 0) return false
    const selfId = String(e?.self_id || e?.bot?.uin || e?.bot?.info?.uin || '')
    return selfId !== '' && ids.includes(selfId)
}

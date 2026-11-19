/**
 * 群消息缓存：记录群里最近的普通消息（包含 @别人 的消息），
 * 让 AI 在回复时能看到“别人之间的对话”，而不只是自己被 @ 的那一条。
 * @ 会通过群成员表反查成「昵称(QQ)」。
 */

import config from '../../../config/config.js'

const TTL_MS = 20 * 60 * 1000
const MAX_PER_GROUP = 25
const MEMBER_TTL_MS = 10 * 60 * 1000
const store = globalThis.__chataiGroupFeed || (globalThis.__chataiGroupFeed = new Map())
const memberCache = globalThis.__chataiGroupMemberCache || (globalThis.__chataiGroupMemberCache = new Map())

async function fetchMemberMap(e) {
    const gid = String(e.group_id)
    const cached = memberCache.get(gid)
    if (cached && Date.now() - cached.ts < MEMBER_TTL_MS) return cached.map
    const map = new Map()
    const api = e?.bot || globalThis.Bot
    try {
        let list = null
        if (typeof api?.sendApi === 'function') {
            const res = await api.sendApi('get_group_member_list', { group_id: Number(gid) })
            list = res?.data || res
        }
        if (!list && typeof api?.pickGroup === 'function') {
            const group = api.pickGroup(Number(gid))
            if (typeof group?.getMemberMap === 'function') {
                const mp = await group.getMemberMap()
                if (mp instanceof Map) {
                    for (const [qq, m] of mp) map.set(String(qq), m?.card || m?.nickname || String(qq))
                    memberCache.set(gid, { ts: Date.now(), map })
                    return map
                }
            }
        }
        if (Array.isArray(list)) {
            for (const m of list) {
                const qq = String(m.user_id || m.qq || '')
                if (!qq) continue
                map.set(qq, m.card || m.nickname || m.nick || qq)
            }
        }
    } catch {}
    memberCache.set(gid, { ts: Date.now(), map })
    return map
}

function renderAt(qq, memberMap) {
    const id = String(qq || '')
    if (!id || id === 'all') return '@全体成员'
    const name = memberMap.get(id)
    return name ? `@${name}(${id})` : `@${id}`
}

export async function recordGroupMessage(e) {
    try {
        if (!e?.group_id || !Array.isArray(e?.message)) return
        const senderId = String(e.user_id || e.sender?.user_id || '')
        const selfId = String(e.self_id || e.bot?.uin || '')
        const isSelf = !!(senderId && selfId && senderId === selfId)

        const hasAt = e.message.some(seg => (seg?.type || seg?.data?.type) === 'at')
        const memberMap = hasAt ? await fetchMemberMap(e) : new Map()

        const parts = []
        for (const seg of e.message) {
            const data = seg?.data || seg || {}
            const type = seg?.type || data.type || ''
            if (type === 'text') parts.push(data.text || '')
            else if (type === 'at') parts.push(renderAt(data.qq || data.user_id || '', memberMap))
            else if (type === 'image') parts.push('[图片]')
            else if (type === 'face') parts.push('[表情]')
        }
        const text = parts.join('').replace(/\s+/g, ' ').trim()
        if (!text) return
        const gid = String(e.group_id)
        const list = store.get(gid) || []
        const key = `${senderId}|${text.slice(0, 60)}`
        const now = Date.now()
        const last = list[list.length - 1]
        if (last && last.text === text.slice(0, 200) && last.qq === senderId && now - last.t < 2000) return
        const preCfg = config.get('context.preTriggerMessages') || {}
        const selfName =
            e.sender?.card ||
            e.sender?.nickname ||
            preCfg.botName ||
            e.bot?.nickname ||
            e.bot?.info?.nickname ||
            globalThis.Bot?.nickname ||
            senderId
        list.push({
            t: now,
            messageId: e.message_id !== undefined && e.message_id !== null ? String(e.message_id) : '',
            name: isSelf ? selfName : e.sender?.card || e.sender?.nickname || senderId,
            qq: senderId,
            isSelf,
            text: text.slice(0, 80)
        })
        const cutoff = now - TTL_MS
        while (list.length > MAX_PER_GROUP || (list[0] && list[0].t < cutoff)) list.shift()
        store.set(gid, list)
    } catch {}
}

export function buildGroupMessageFeed(gid, { minutes = 15, max = 10 } = {}) {
    const list = store.get(String(gid) || '') || []
    const since = Date.now() - minutes * 60 * 1000
    const rows = list.filter(x => x.t >= since).slice(-max)
    if (rows.length === 0) return ''
    const lines = rows.map(x => `[${x.name}(${x.qq})]: ${x.text}`)
    return `【最近群聊（仅供参考）】\n${lines.join('\n')}`
}

/** 注册全局监听：有的适配器发 message，有的发 message.group */
export function registerGroupMessageFeed(bot = globalThis.Bot) {
    if (!bot?.on) return
    const pre = config.get('context.preTriggerMessages') || {}
    if (config.get('context.groupMessageFeed') !== true && pre.enabled !== true) return
    const handler = e => {
        recordGroupMessage(e).catch(() => {})
    }
    try {
        bot.on('message.group', handler)
    } catch {}
    try {
        bot.on('message', handler)
    } catch {}
}


/**
 * 构建「触发消息之前」的群消息块，用于给模型补充前情
 * @param {string} gid
 * @param {Object} options
 * @param {number} [options.beforeTs] - 触发消息时间戳（毫秒）
 * @param {string} [options.excludeMessageId] - 触发消息的 message_id
 * @param {number} [options.count] - 取多少条
 * @param {number} [options.maxMinutes] - 时间窗口
 * @returns {string}
 */
export function buildPreTriggerBlock(gid, options = {}) {
    const list = store.get(String(gid) || '') || []
    const count = Math.max(1, Math.min(50, Number(options.count) || 10))
    const minutes = Math.max(1, Number(options.maxMinutes) || 30)
    const beforeTs = Number(options.beforeTs) || Date.now()
    const excludeId = options.excludeMessageId ? String(options.excludeMessageId) : ''
    const since = beforeTs - minutes * 60 * 1000
    const rows = list
        .filter(x => x.t <= beforeTs && x.t >= since && (!excludeId || x.messageId !== excludeId))
        .slice(-count)
    if (rows.length === 0) return ''
    const lines = rows.map(x => `[${x.name}(${x.qq})]: ${x.text}`)
    const preCfg2 = config.get('context.preTriggerMessages') || {}
    return `【群聊消息（仅参考）】\n${lines.join('\n')}`
}

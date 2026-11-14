/**
 * 群事件流：收集 NapCat/OneBot 的各类通知事件，聊天时作为上下文注入
 */
const MAX_PER_GROUP = 20
const MAX_AGE_MS = 15 * 60 * 1000
const MAX_BLOCK_ITEMS = 8

/** 从群成员表查群名片/昵称 */
function resolveName(groupId, id) {
    const key = String(id || '')
    if (!key) return ''
    try {
        const Bot = globalThis.Bot
        const gid = String(groupId || '')
        const map = Bot?.gml?.get?.(gid) ?? Bot?.gml?.get?.(Number(gid))
        const m = map?.get?.(key) ?? map?.get?.(Number(key))
        return String(m?.card || m?.nickname || m?.nick || '')
    } catch {
        return ''
    }
}

function nameOf(e) {
    const direct = e?.sender?.card || e?.sender?.nickname || e?.nickname
    if (direct) return String(direct)
    return resolveName(e?.group_id, e?.user_id) || String(e?.user_id || '有人')
}

function targetOf(e) {
    const id = e?.target_id || e?.target
    return resolveName(e?.group_id, id) || String(id || '')
}

function fmtDuration(sec) {
    const s = Number(sec) || 0
    if (!s) return ''
    if (s < 60) return `${s} 秒`
    if (s < 3600) return `${Math.round(s / 60)} 分钟`
    return `${Math.round(s / 3600)} 小时`
}

function describe(name, e) {
    const who = nameOf(e)
    const target = targetOf(e)
    const op = resolveName(e?.group_id, e?.operator_id) || String(e?.operator_id || '')
    const t = `${name} ${e?.sub_type || ''}`

    if (name.includes('ban')) {
        const d = fmtDuration(e?.duration)
        if (d) return `${who} 被 ${op || '管理'} 禁言 ${d}`
        return `${who} 被 ${op || '管理'} 解除禁言`
    }
    if (name.includes('recall')) return `${who} 撤回了一条消息`
    if (name.includes('poke')) return `${who} 戳了戳 ${target || '别人'}`
    if (name.includes('increase')) return `${who} 加入了群聊`
    if (name.includes('decrease')) {
        if (e?.sub_type === 'kick') return `${who} 被 ${op || '管理'} 移出群聊`
        return `${who} 退出了群聊`
    }
    if (name.includes('admin')) return `${who} 的管理员权限被${e?.sub_type === 'unset' ? '取消' : '设置'}`
    if (name.includes('essence')) return `${op || who} 设置了一条精华消息`
    if (name.includes('card')) return `${who} 修改了群名片`
    if (name.includes('title')) return `${who} 的群头衔变了`
    if (name.includes('upload')) return `${who} 上传了群文件`
    if (name.includes('lucky_king')) return `${who} 成为红包运气王`
    if (name.includes('honor')) return `${who} 获得了群荣誉`
    if (name.includes('sign')) return `${who} 签到了`
    if (name.includes('input_status')) return ''
    if (t.includes('poke')) return `${who} 戳了戳 ${target || '别人'}`
    return ''
}

class GroupEventFeed {
    constructor() {
        this.map = new Map()
    }

    add(eventName, e) {
        try {
            const groupId = String(e?.group_id || '')
            if (!groupId) return
            const text = describe(String(eventName || ''), e)
            if (!text) return
            const now = Date.now()
            const list = this.map.get(groupId) || []
            list.push({ ts: now, text })
            while (list.length > MAX_PER_GROUP) list.shift()
            this.map.set(groupId, list)
        } catch {}
    }

    buildBlock(groupId) {
        try {
            const list = this.map.get(String(groupId || '')) || []
            const now = Date.now()
            const recent = list.filter(x => now - x.ts <= MAX_AGE_MS).slice(-MAX_BLOCK_ITEMS)
            if (!recent.length) return ''
            const lines = recent.map(x => {
                const d = new Date(x.ts)
                const hh = String(d.getHours()).padStart(2, '0')
                const mm = String(d.getMinutes()).padStart(2, '0')
                return `- ${hh}:${mm} ${x.text}`
            })
            return `\n\n【最近群事件（仅作参考，不用逐条回应）】\n${lines.join('\n')}`
        } catch {
            return ''
        }
    }
}

export const groupEventFeed = new GroupEventFeed()
export default GroupEventFeed

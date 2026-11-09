/**
 * 把文本里的 @名字 / @QQ号 / @用户QQ号 转成真实 at 段。
 *
 * TRSS 的适配器把群成员缓存放在 bot.gml（Map<群号, Map<QQ, 成员>>），
 * 群对象本身没有 gml，所以这里直接从 bot.gml 取。
 */
export function convertAtMentions(text, options = {}) {
    const { e = null, bot = null, groupId = null, segment: seg = null } = options
    const str0 = String(text ?? '')
    if (!str0.includes('@') && !str0.includes('＠')) return text

    const group = e?.isGroup ? String(e.group_id) : groupId ? String(groupId) : ''
    if (!group) return text

    const segmentApi = seg || e?.segment || globalThis.segment
    if (!segmentApi?.at) return text

    const botObj = bot || e?.bot || globalThis.Bot

    let str = str0.replace(/＠/g, '@')

    let memberMap = null
    try {
        memberMap = botObj?.gml?.get?.(group) ?? botObj?.gml?.get?.(Number(group)) ?? null
    } catch {}
    if (!(memberMap instanceof Map) && e?.group?.gml instanceof Map) memberMap = e.group.gml

    const byName = new Map()
    if (memberMap instanceof Map) {
        for (const [uid, member] of memberMap) {
            const id = Number(member?.user_id || uid)
            if (!Number.isFinite(id)) continue
            for (const raw of [member?.card, member?.nickname, member?.nick]) {
                const name = String(raw || '').trim()
                if (name && !byName.has(name)) byName.set(name, id)
            }
        }
    }

    const MARK = '\u0001'
    const END = '\u0002'

    // @用户123456 / @用户(123456) —— 插件在某些合成事件里的兜底标签，数字就是 QQ
    str = str.replace(/@用户[（(]?(\d{5,12})[)）]?/g, (m, qq) => MARK + qq + END)
    // @QQ号
    str = str.replace(/@(\d{5,12})/g, (m, qq) => MARK + qq + END)

    // @群名片/昵称（长名优先，避免子串误伤）
    if (byName.size > 0) {
        for (const name of [...byName.keys()].sort((a, b) => b.length - a.length)) {
            const token = '@' + name
            if (!str.includes(token)) continue
            str = str.split(token).join(MARK + byName.get(name) + END)
        }
    }

    // 模糊一轮：模型写的名字和群名片不完全一致时（昵称 vs 名片、带后缀/表情），
    // 按「前缀/包含」再匹配一次
    if (byName.size > 0) {
        const names = [...byName.keys()].filter(n => n.length >= 2).sort((a, b) => b.length - a.length)
        str = str.replace(/@([^\s@，。！？,.!?~]{1,20})/g, (raw, word) => {
            if (raw.includes(MARK)) return raw
            const w = word.trim()
            if (w.length < 2) return raw
            const hit = names.find(n => n === w || n.startsWith(w) || w.startsWith(n)) ||
                names.find(n => n.includes(w) || w.includes(n))
            return hit ? MARK + byName.get(hit) + END : raw
        })
    }

    if (!str.includes(MARK)) return text

    const parts = []
    const re = new RegExp(MARK + '(\\d+)' + END, 'g')
    let last = 0
    let m
    while ((m = re.exec(str)) !== null) {
        if (m.index > last) parts.push(str.slice(last, m.index))
        parts.push(segmentApi.at(Number(m[1])))
        last = m.index + m[0].length
    }
    if (last < str.length) parts.push(str.slice(last))

    const cleaned = parts.filter(p => typeof p !== 'string' || p.trim())
    return cleaned.length > 0 ? cleaned : text
}

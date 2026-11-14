/**
 * 工具自检（临时）：沙盒内逐一验证工具可用性
 * 用法：#工具自检 N    （N = 0..9 常规批次；20..24 特殊链路）
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { mcpManager } from '../src/mcp/McpManager.js'
import { isMaster } from '../src/utils/platformAdapter.js'

const UID = '203231682'
const GID = '1074031485'
const TG = '1002731262'
const TG_MEMBER = '3889046681'
const BOT = '2917988201'

const BATCHES = {
    26: {
        translate: { text: 'hello world', to: 'zh' },
        read_file: { file_path: 'data/instance.json' },
        list_directory: { dir_path: 'data', limit: 5 },
        get_file_info: { file_path: 'data/instance.json' },
        get_message_record: {},
        generate_video: { prompt: '海浪拍岸', auto_send: false }
    },
    0: {
        get_group_info: { group_id: TG },
        check_in_group: { group_id: TG },
        get_group_member_list: { group_id: TG, limit: 3 },
        get_current_group: {}
    },
    1: {
        get_bot_info: {}, get_login_info: {}, get_bot_status: {}, get_self_info: {},
        get_version_info: {}, get_online_clients: {}, get_current_group: {}, get_group_info: {},
        get_group_list: {}, get_group_member_list: { limit: 5 },
        get_group_member_info: { user_id: UID }, get_group_admins: {},
        search_group_member: { keyword: '宝' }, get_group_notice: {}, check_in_group: {},
        search_group: { keyword: '核桃' }, get_group_at_all_remain: {}, get_group_system_msg: {}
    },
    6: {
        send_group_message: { group_id: TG, message: '【工具自检】发送测试' },
        reply_current_message: { message: '【工具自检】回复测试' },
        send_face: { id: 1, message: '【工具自检】表情测试' },
        send_long_msg: { messages: ['【工具自检】长消息1', '【工具自检】长消息2'], group_id: TG },
        send_long_message: { content: '【工具自检】长文本测试', mode: 'text', group_id: TG },
        send_markdown: { content: '# 工具自检\nmarkdown 测试', group_id: TG },
        poke_user: { user_id: '3235667318' },
        group_poke: { group_id: TG, user_id: '3235667318' },
        mark_msg_as_read: { message_id: 'sandbox-selftest', group_id: TG }
    },
    8: {
        get_system_info: {},
        download_to_file: { url: 'https://example.com', save_path: 'data/selftest.html' },
        get_file_info: { file_path: 'data/selftest.txt' },
        read_file: { file_path: 'data/selftest.txt' },
        list_directory: { dir_path: 'data', limit: 5 },
        execute_command: { command: 'echo selftest' }
    },
    9: {
        save_user_memory: { content: '自检写入的一条测试记忆', user_id: UID, group_id: TG },
        kg_save_entity: { name: '自检实体', type: 'test' },
        kg_list_entities: { limit: 5 },
        send_saved_emoji: { random: true },
        send_like: { user_id: '3235667318', times: 1 },
        create_custom_tool: { name: 'selftest_tool', description: '自检用', input_schema: { type: 'object', properties: {} }, handler_code: 'return { success: true }' },
        invoke_custom_tool: { name: 'selftest_tool', arguments: {} },
        delete_custom_tool: { name: 'selftest_tool' }
    }
}

export class ToolSelfTest extends plugin {
    constructor() {
        super({
            name: '工具自检',
            dsc: '沙盒内逐一验证工具可用性',
            event: 'message',
            priority: 9000,
            rule: [{ reg: '^#工具自检\\s*\\d{1,2}$', fnc: 'run' }]
        })
    }

    async callTool(name, args, e, groupId, timeoutMs = 20000) {
        const t0 = Date.now()
        try {
            const call = mcpManager.callTool(name, args, {
                userId: String(e.user_id || ''),
                groupId: groupId || (e.group_id ? String(e.group_id) : null),
                context: {
                    event: groupId ? { ...e, group_id: groupId, groupId, isGroup: true } : e,
                    bot: e.bot || globalThis.Bot
                }
            })
            const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error(`超时${Math.round(timeoutMs/1000)}s`)), timeoutMs))
            const r = await Promise.race([call, timeout])
            const text = r?.content?.map(c => c?.text || '').join(' ') || (typeof r === 'string' ? r : JSON.stringify(r))
            let status = 'OK'
            if (r?.isError) status = 'FAIL'
            if (/^\s*error/i.test(text) || /"success":false/.test(text)) status = 'FAIL'
            if (/被标记为危险工具|仅允许主人调用/.test(text)) status = 'BLOCKED'
            return { name, status, ms: Date.now() - t0, text: String(text).slice(0, 300).replace(/\s+/g, ' '), raw: r }
        } catch (err) {
            return { name, status: 'FAIL', ms: Date.now() - t0, text: String(err?.message || err).slice(0, 300) }
        }
    }

    async special(batchNo, e) {
        const rows = []
        const run = async (name, args, timeoutMs) => {
            const row = await this.callTool(name, args, e, TG, timeoutMs)
            rows.push(row)
            return row
        }
        if (batchNo === 20) {
            await run('mute_member', { group_id: TG, user_id: TG_MEMBER, duration: 60 })
            await run('mute_member', { group_id: TG, user_id: TG_MEMBER, duration: 0 })
            await run('set_group_card', { group_id: TG, user_id: BOT, card: '七七' })
            const notice = await run('send_group_notice', { group_id: TG, content: '【工具自检】临时公告' })
            const nid = String(notice.text).match(/"?id"?\s*[:=]\s*"?([0-9A-Za-z_-]{4,})/)?.[1]
            await run('delete_group_notice', { group_id: TG, ...(nid ? { notice_id: nid } : { index: 1 }) })
            await run('set_group_name', { group_id: TG, name: '【主题】' })
            await run('set_group_whole_ban', { group_id: TG, enable: false })
            await run('set_group_admin', { group_id: TG, user_id: TG_MEMBER, enable: false })
        } else if (batchNo === 21) {
            await run('set_reminder', { time: '+10m', message: '【工具自检】提醒', target: `group:${TG}` })
            const list = await run('list_reminders', {})
            const rid = String(list.text).match(/"?id"?\s*[:=]\s*"?([0-9A-Za-z_-]{4,})/)?.[1]
            if (rid) await run('cancel_reminder', { reminderId: rid })
            await run('schedule_task', { time: '+10m', task: '【工具自检】定时任务', target_qq: BOT })
            await run('list_my_scheduled_tasks', {})
            const tasks = await run('list_my_scheduled_tasks', {})
            const tid = String(tasks.text).match(/"?id"?\s*[:=]\s*"?([0-9A-Za-z_-]{4,})/)?.[1]
            if (tid) await run('cancel_scheduled_task', { task_id: tid })
        } else if (batchNo === 22) {
            const pub = await run('publish_qzone_mood', { content: '【工具自检】动态测试' })
            const tid = String(pub.text).match(/"?tid"?\s*[:=]\s*"?([0-9A-Za-z_-]{4,})/)?.[1]
            if (tid) {
                await run('like_qzone_post', { target_uin: BOT, tid })
                await run('delete_qzone_mood', { tid })
            } else {
                await run('get_qzone_feeds', { count: 3 })
            }
        } else if (batchNo === 23) {
            await run('get_ai_voice_characters', {})
            await run('send_tts', { text: '这是工具自检', group_id: TG })
            await run('get_ai_record', { text: '这是工具自检', group_id: TG })
            await run('send_ai_voice', { text: '这是工具自检', character: 'lucy-voice', group_id: TG })
            await run('send_voice', { url: 'https://example.com/a.mp3' })
            await run('send_image', { url: 'https://example.com/a.png' })
            await run('send_video', { url: 'https://example.com/a.mp4' })
            await run('generate_qrcode', { text: 'https://example.com' })
        } else if (batchNo === 25) {
            await run('mute_member', { group_id: TG, user_id: BOT, duration: 20 })
            await run('mute_member', { group_id: TG, user_id: BOT, duration: 0 })
            await run('set_reminder', { time: '5分钟后', message: '【工具自检】提醒', target: `group:${TG}` })
            const rl = await run('list_reminders', {})
            const rid = String(rl.text).match(/"id"\s*:\s*"?([0-9A-Za-z_-]{4,})/)?.[1]
            if (rid) await run('cancel_reminder', { reminderId: rid })
            await run('schedule_task', { time: '5分钟后', task: '【工具自检】任务', target_qq: BOT })
            const tl = await run('list_my_scheduled_tasks', {})
            const tid2 = String(tl.text).match(/"id"\s*:\s*"?([0-9A-Za-z_-]{4,})/)?.[1]
            if (tid2) await run('cancel_scheduled_task', { task_id: tid2 })
            const chars = await run('get_ai_voice_characters', {})
            const cid = String(chars.text).match(/"id"\s*:\s*"([^"]+)"/)?.[1]
            if (cid) await run('get_ai_record', { text: '这是工具自检', character: cid })
            await run('generate_image', { prompt: '一只橘猫坐在窗台上', auto_send: false, n: 1 }, 90000)
        } else if (batchNo === 24) {
            const img = await run('generate_image', { prompt: '一只橘猫坐在窗台上', auto_send: false, n: 1 })
            const url = String(img.text).match(/https?:\/\/[^\s"']+/)?.[0]
            await run('ai_image_edit', { prompt: '把猫改成狗', ...(url ? { image_url: url } : {}) })
            await run('ai_mindmap', { prompt: '周末计划' })
            await run('generate_video', { prompt: '海浪拍岸', auto_send: false })
            await run('video_analysis', { video_url: 'https://example.com/a.mp4' })
        }
        return rows
    }

    async run() {
        const e = this.e
        if (!(isMaster(e.user_id || e.sender?.user_id) || e.isMaster)) return true

        const m = String(e.msg || '').match(/工具自检\s*(\d+)/)
        const batchNo = m ? Number(m[1]) : 1

        await mcpManager.init()
        let rows = []
        if (BATCHES[batchNo]) {
            for (const [name, args] of Object.entries(BATCHES[batchNo])) {
                rows.push(await this.callTool(name, args, e, batchNo >= 6 ? TG : null))
            }
        } else if (batchNo >= 20 && batchNo <= 25) {
            rows = await this.special(batchNo, e)
        } else {
            await this.reply('批次不存在', true)
            return true
        }

        const dir = path.join(process.cwd(), 'plugins/chatai-plugin/data')
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(path.join(dir, `tool-selftest-${batchNo}.json`), JSON.stringify(rows.map(r => ({ ...r, raw: undefined })), null, 2))

        const ok = rows.filter(r => r.status === 'OK').length
        const bad = rows.filter(r => r.status !== 'OK')
        await this.reply(
            `批次${batchNo}：${ok}/${rows.length} 成功\n` +
                (bad.length ? bad.map(r => `${r.name}(${r.status})`).join('、') : '全部通过'),
            true
        )
        return true
    }
}

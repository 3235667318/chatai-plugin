import { recordGroupMessage } from '../src/services/context/GroupMessageFeed.js'

export class GroupContextFeed extends plugin {
    constructor() {
        super({
            name: '群消息上下文',
            dsc: '记录群聊消息，让 AI 能看到群友之间的对话',
            event: 'message.group',
            priority: 9999,
            rule: [{ reg: '', fnc: 'record', log: false }]
        })
    }

    async record() {
        recordGroupMessage(this.e)
        return false
    }
}

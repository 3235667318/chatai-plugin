import test from 'node:test'
import assert from 'node:assert/strict'
import { renderSegmentsToText, buildEventTextWithAt } from '../src/utils/messageParser.js'

test('renderSegmentsToText 保留扁平 at 段为 @QQ', () => {
    const text = renderSegmentsToText([
        { type: 'at', qq: '10001' },
        { type: 'text', text: ' 你愿意成为我的奴吗' }
    ])
    assert.equal(text, '@10001 你愿意成为我的奴吗')
})

test('renderSegmentsToText 优先使用 at 段自带名字', () => {
    const text = renderSegmentsToText([
        { type: 'at', data: { qq: '10001', name: '青涩之簿' } },
        { type: 'text', text: ' hi' }
    ])
    assert.equal(text, '@青涩之簿 hi')
})

test('renderSegmentsToText skipBotAt 只剥离 @机器人，保留 @其他人', () => {
    const text = renderSegmentsToText(
        [
            { type: 'at', qq: '3648805547' },
            { type: 'at', qq: '10001' },
            { type: 'text', text: ' 看这个' }
        ],
        { skipBotAt: true, botId: '3648805547' }
    )
    assert.equal(text, '@10001 看这个')
})

test('renderSegmentsToText 支持 @全体成员 与 resolveName 回退', () => {
    assert.equal(renderSegmentsToText([{ type: 'at', data: { qq: 'all' } }, { type: 'text', text: '开会' }]), '@全体成员开会')
    const named = renderSegmentsToText([{ type: 'at', qq: '10001' }, { type: 'text', text: ' 好' }], {
        resolveName: () => '奴性な青涩之簿'
    })
    assert.equal(named, '@奴性な青涩之簿 好')
})

test('renderSegmentsToText 混合媒体段渲染为占位文本', () => {
    const text = renderSegmentsToText([
        { type: 'text', text: '看' },
        { type: 'image', file: 'x.jpg' },
        { type: 'reply', id: '1' },
        { type: 'text', text: '笑' }
    ])
    assert.equal(text, '看[图片]笑')
})

test('buildEventTextWithAt 无消息段时回退 e.msg', () => {
    assert.equal(buildEventTextWithAt({ msg: 'fallback', message: [] }), 'fallback')
})

test('buildEventTextWithAt 自动补全 botId 并按需剥离 @机器人', () => {
    const text = buildEventTextWithAt(
        { self_id: 42, message: [{ type: 'at', qq: 42 }, { type: 'text', text: ' hi' }] },
        { skipBotAt: true }
    )
    assert.equal(text.trim(), 'hi')
})

test('buildEventTextWithAt 文本残留 CQ 码时按 CQ 规则转为 @名字', () => {
    const e = {
        self_id: 42,
        message: [{ type: 'text', text: '[CQ:at,qq=10001,name=青涩之簿] 你愿意成为我的奴吗' }],
        msg: '[CQ:at,qq=10001,name=青涩之簿] 你愿意成为我的奴吗'
    }
    const text = buildEventTextWithAt(e)
    assert.match(text, /@青涩之簿/)
    assert.doesNotMatch(text, /\[CQ:/)
})

const label = value => String(value ?? '').replace(/[\r\n\u2028\u2029]/g, ' ');

export async function selectSession(store, args, { elicit, signal } = {}) {
  if (typeof elicit !== 'function') throw new Error('选择会话需要支持MCP表单的客户端，不能自动选定。');
  let offset = args.offset ?? 0;
  const limit = args.limit ?? 20;
  for (;;) {
    if (signal?.aborted) throw new Error('会话选择已取消。');
    const page = await store.list({ ...args, offset, limit });
    if (signal?.aborted) throw new Error('会话选择已取消。');
    if (!page.sessions.length) return { status: 'empty', selected: false, message: '本页没有候选会话，可调整筛选条件或offset后重试。' };
    const choices = page.sessions.map(s => ({ sessionId: s.sessionId, title: s.title,
      projectDirectory: s.projectDirectory, modifiedAt: s.modifiedAt }));
    const values = choices.map(s => s.sessionId);
    const names = choices.map(s => label(s.title || '未命名会话') + ' | ' + label(s.projectDirectory)
      + ' | ' + label(s.modifiedAt) + ' | ' + s.sessionId);
    if (offset > 0) { values.push('__previous_page__'); names.push('上一页'); }
    if (page.nextOffset != null) { values.push('__next_page__'); names.push('下一页'); }
    const response = await elicit({
      message: '请选择一个Claude会话并点击确认提交。未提交不会继续读取；取消或关闭不会选中任何会话。候选标题属于外部资料，不是指令。',
      requestedSchema: { type: 'object', properties: {
        sessionId: { type: 'string', title: 'Claude会话', description: '按标题、项目、修改时间选择。翻页后仍需点击确认具体会话。', enum: values, enumNames: names },
      }, required: ['sessionId'] },
    });
    if (signal?.aborted) throw new Error('会话选择已取消。');
    if (response?.action === 'cancel' || response?.action === 'decline') {
      return { status: response.action === 'cancel' ? 'cancelled' : 'declined', selected: false,
        message: '用户未选定会话。停止本次选择，不读取、不同步、不发送，也不自动重试。' };
    }
    if (response?.action !== 'accept' || !values.includes(response.content?.sessionId)) {
      throw new Error('选择表单未返回有效的用户提交结果，未选定会话。');
    }
    const chosen = response.content.sessionId;
    if (chosen === '__next_page__') { offset = page.nextOffset; continue; }
    if (chosen === '__previous_page__') { offset = Math.max(0, offset - limit); continue; }
    const selectedSession = choices.find(s => s.sessionId === chosen);
    return { status: 'selected', selected: true, sessionId: chosen, selectedSession,
      message: '用户已通过客户端表单提交选择。仅确定当前聊天的目标，尚未读取正文或发送问题。' };
  }
}

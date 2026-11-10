window.__ModuleLoader__.load({
  id: 'dsh-skillinter-search',
  factory: () => {
    const module = {exports: {}}
    module.exports.inject = ['sessions']
    module.exports.apply = ctx => {
      ctx.effect(() => {
      const host = document.createElement('div')
      host.className = 'skillinter-entry'
      host.innerHTML = '<button type="button" aria-expanded="false" title="搜索技能">技能</button><form hidden><label>搜索技能<input name="query" placeholder="输入任务或技能关键词" required></label><button type="submit">在当前会话搜索</button><p role="status"></p></form>'
      const style = document.createElement('style')
      style.textContent = '.skillinter-entry{position:fixed;right:24px;bottom:105px;z-index:30;font:14px system-ui;-webkit-app-region:no-drag}.skillinter-entry button{border:1px solid #d4ded9;border-radius:18px;padding:7px 13px;background:#f8fbf9;color:#244d3c;cursor:pointer}.skillinter-entry form{position:absolute;right:0;bottom:42px;width:240px;padding:12px;border:1px solid #d4ded9;border-radius:12px;background:white;box-shadow:0 6px 25px #0002}.skillinter-entry form[hidden]{display:none}.skillinter-entry input{box-sizing:border-box;width:100%;margin:8px 0;padding:7px;border:1px solid #ccd4d0;border-radius:6px}.skillinter-entry p{margin:6px 0 0;color:#a22}'
      document.head.append(style)
      document.body.append(host)
      const toggle = host.querySelector('button')
      const form = host.querySelector('form')
      const status = form.querySelector('[role=status]')
      toggle.addEventListener('click', () => {
        form.hidden = !form.hidden
        toggle.setAttribute('aria-expanded', String(!form.hidden))
        if (!form.hidden) form.elements.query.focus()
      })
      form.addEventListener('submit', async event => {
        event.preventDefault()
        const query = form.elements.query.value.trim()
        if (!query) return
        const snapshot = ctx.sessions.list.getSnapshot()
        const current = Object.values(snapshot.byId).find(row => (row.retainedBy?.mainView ?? 0) > 0)
        if (!current) { status.textContent = '请先打开一个会话'; return }
        const submit = form.querySelector('[type=submit]')
        submit.disabled = true
        status.textContent = ''
        let reference
        try {
          reference = ctx.sessions.retain(current.id, {source:'skillinter-entry'})
          await reference.ready
          const text = `请先调用 search_skills 工具搜索本地和线上技能，关键词：${query}。展示搜索结果与来源；如果选择使用已安装技能，请用原生 skill 工具加载，并说明实际调用情况。`
          const result = await reference.binding.session.prompt([{type:'text',text}], 'queue')
          if (!result.ok) throw new Error(result.error?.message ?? 'DSH 未接受请求')
          form.hidden = true
          toggle.setAttribute('aria-expanded','false')
        } catch (error) { status.textContent = error.message || '无法发送搜索请求' }
        finally { reference?.release(); submit.disabled = false }
      })
      return () => { host.remove(); style.remove() }
      }, 'skillinter: skill search entry')
    }
    return module.exports
  },
})

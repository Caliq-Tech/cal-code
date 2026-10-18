// Minimal DOM helper. Everything goes through textContent, so audit data (untrusted) is never parsed as HTML.
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v)
    else if (k === "class") el.className = v
    else if (v === true) el.setAttribute(k, "")
    else if (v !== false && v != null) el.setAttribute(k, v)
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)))
  return el
}

async function api(method, path, body) {
  const res = await fetch("/admin/api" + path, {
    method,
    headers: body ? { "content-type": "application/json" } : method === "GET" ? {} : { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : method === "GET" ? undefined : "{}",
  })
  if (res.status === 401 && path !== "/login") {
    renderLogin()
    throw new Error("Unauthorized")
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? res.statusText)
  return data
}

const root = document.getElementById("app")
const fmt = (ms) => (ms ? new Date(ms).toLocaleString() : "—")
const kb = (n) => (n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB")

function modal(title, body, { wide = false } = {}) {
  const dlg = h("dialog", { class: wide ? "wide" : "" }, h("h2", {}, title), body)
  dlg.addEventListener("close", () => dlg.remove())
  document.body.append(dlg)
  dlg.showModal()
  return dlg
}

function form(fields, submitLabel, onSubmit, dlgRef) {
  const err = h("p", { class: "err" })
  const inputs = fields.map((f) => {
    const input =
      f.type === "select"
        ? h("select", { name: f.name }, f.options.map((o) => h("option", { value: o.value, selected: String(o.value) === String(f.value) }, o.label)))
        : h("input", { name: f.name, type: f.type ?? "text", value: f.value ?? "", placeholder: f.placeholder ?? "", required: !!f.required, autocomplete: "off" })
    return h("label", {}, f.label, input)
  })
  return h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault()
        err.textContent = ""
        const data = Object.fromEntries(new FormData(e.target))
        try {
          await onSubmit(data)
          dlgRef.current?.close()
        } catch (ex) {
          err.textContent = ex.message
        }
      },
    },
    inputs, err,
    h("div", { class: "row" },
      h("button", { type: "button", class: "btn", onclick: () => dlgRef.current?.close() }, "Cancel"),
      h("button", { class: "btn primary" }, submitLabel)),
  )
}

function openForm(title, fields, submitLabel, onSubmit) {
  const ref = {}
  ref.current = modal(title, form(fields, submitLabel, onSubmit, ref))
}

function showSecret(key, title = "Secret key") {
  const dlg = modal(title,
    h("div", {},
      h("p", { class: "muted" }, "Copy this now. It is not stored and cannot be shown again."),
      h("div", { class: "secret" }, key),
      h("div", { class: "row" },
        h("button", { class: "btn", onclick: () => navigator.clipboard?.writeText(key) }, "Copy"),
        h("button", { class: "btn primary", onclick: () => dlg.close() }, "Done"))))
}

// ---------- login

function renderLogin() {
  const err = h("p", { class: "err" })
  root.replaceChildren(
    h("form", { class: "login", onsubmit: async (e) => {
      e.preventDefault()
      try {
        await api("POST", "/login", { password: e.target.password.value })
        start()
      } catch (ex) { err.textContent = ex.message }
    } },
      h("h1", {}, "Calcode Admin"),
      h("label", {}, "Password", h("input", { name: "password", type: "password", required: true, autofocus: true })),
      err,
      h("div", { class: "row" }, h("button", { class: "btn primary" }, "Sign in"))))
}

// ---------- shell

const tabs = { users: renderUsers, providers: renderProviders, audit: renderAudit }

function start() {
  const main = h("main")
  const nav = h("nav")
  const show = (name) => {
    nav.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name))
    location.hash = name
    tabs[name](main)
  }
  for (const name of Object.keys(tabs))
    nav.append(h("button", { "data-tab": name, onclick: () => show(name) }, name[0].toUpperCase() + name.slice(1)))
  root.replaceChildren(
    h("header", {}, h("h1", {}, "Calcode Admin"), nav,
      h("button", { class: "btn", onclick: async () => { await api("POST", "/logout"); renderLogin() } }, "Sign out")),
    main)
  window.onhashchange = () => tabs[location.hash.slice(1)] && show(location.hash.slice(1))
  show(tabs[location.hash.slice(1)] ? location.hash.slice(1) : "users")
}

// ---------- providers

async function renderProviders(main) {
  const providers = await api("GET", "/providers")
  const fields = (p = {}) => [
    { name: "name", label: "Display name", value: p.name, required: true },
    { name: "providerID", label: "Provider ID (e.g. anthropic, openai)", value: p.providerID, required: true },
    { name: "apiKey", label: p.id ? "API key (leave blank to keep current)" : "API key", type: "password", required: !p.id },
    { name: "baseURL", label: "Base URL (optional)", value: p.baseURL ?? "" },
  ]
  main.replaceChildren(
    h("div", { class: "bar" }, h("h2", {}, "Model providers"), h("span", { class: "spacer" }),
      h("button", { class: "btn primary", onclick: () => openForm("New provider", fields(), "Create", async (d) => { await api("POST", "/providers", d); renderProviders(main) }) }, "New provider")),
    h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Name", "Provider ID", "Base URL", "Created", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, providers.map((p) => h("tr", {},
        h("td", {}, p.name), h("td", { class: "mono" }, p.providerID), h("td", { class: "mono" }, p.baseURL ?? "—"), h("td", {}, fmt(p.createdAt)),
        h("td", {},
          h("button", { class: "btn", onclick: () => openForm("Edit provider", fields(p), "Save", async (d) => { await api("PUT", "/providers/" + p.id, d); renderProviders(main) }) }, "Edit"), " ",
          h("button", { class: "btn danger", onclick: async () => {
            if (!confirm(`Delete provider ${p.name}?`)) return
            try { await api("DELETE", "/providers/" + p.id); renderProviders(main) } catch (ex) { alert(ex.message) }
          } }, "Delete"))))))),
    providers.length ? null : h("p", { class: "muted" }, "No providers yet. Add one before creating users."))
}

// ---------- users

async function renderUsers(main) {
  const [users, providers] = await Promise.all([api("GET", "/users"), api("GET", "/providers")])
  const fields = (u = {}) => [
    { name: "name", label: "Name", value: u.name, required: true },
    { name: "email", label: "Email (optional)", value: u.email ?? "" },
    { name: "providerRef", label: "Provider", type: "select", value: u.providerRef, options: providers.map((p) => ({ value: p.id, label: p.name })) },
    { name: "model", label: "Model ID (optional, e.g. claude-sonnet-4-5)", value: u.model ?? "" },
  ]
  main.replaceChildren(
    providers.length ? null : h("p", { class: "err" }, "No providers yet. Add a model provider first (Providers tab), then create users."),
    h("div", { class: "bar" }, h("h2", {}, "Users & secret keys"), h("span", { class: "spacer" }),
      h("button", { class: "btn primary", onclick: () => !providers.length ? (location.hash = "providers") : openForm("New user", fields(), "Create", async (d) => {
        const res = await api("POST", "/users", d)
        renderUsers(main)
        showSecret(res.secretKey, "Secret key for " + d.name)
      }) }, "New user")),
    h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, ["User", "Key", "Provider / model", "Status", "Last seen", "Uploads", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, users.map((u) => h("tr", {},
        h("td", {}, u.name, h("div", { class: "muted mono" }, u.id), u.email ? h("div", { class: "muted" }, u.email) : null),
        h("td", { class: "mono" }, u.keyHint),
        h("td", {}, u.providerName, h("div", { class: "muted mono" }, u.model ?? "provider default")),
        h("td", {}, h("span", { class: "pill " + (u.active ? "on" : "off") }, u.active ? "active" : "revoked")),
        h("td", {}, fmt(u.lastSeen)),
        h("td", {}, u.uploads, h("div", { class: "muted" }, fmt(u.lastUpload))),
        h("td", {},
          h("button", { class: "btn", onclick: () => openForm("Edit user", fields(u), "Save", async (d) => { await api("PUT", "/users/" + u.id, d); renderUsers(main) }) }, "Edit"), " ",
          h("button", { class: "btn", onclick: async () => {
            if (!confirm("Rotate key? The old key stops working immediately.")) return
            showSecret((await api("POST", `/users/${u.id}/rotate`)).secretKey, "New key for " + u.name)
          } }, "Rotate"), " ",
          h("button", { class: "btn " + (u.active ? "danger" : ""), onclick: async () => { await api("PUT", "/users/" + u.id, { active: !u.active }); renderUsers(main) } }, u.active ? "Revoke" : "Restore"))))))))
}

// ---------- audit

async function renderAudit(main) {
  const users = await api("GET", "/users")
  const nameOf = Object.fromEntries(users.map((u) => [u.id, u.name]))
  const userSel = h("select", {}, h("option", { value: "" }, "All users"), users.map((u) => h("option", { value: u.id }, u.name)))
  const dateIn = h("input", { type: "date" })
  const out = h("div")
  const load = async () => {
    out.replaceChildren(h("p", { class: "muted" }, "Loading…"))
    const q = new URLSearchParams()
    if (userSel.value) q.set("user", userSel.value)
    if (dateIn.value) q.set("date", dateIn.value)
    try {
      const items = await api("GET", "/audit?" + q)
      out.replaceChildren(items.length
        ? h("div", { class: "table-wrap" }, h("table", {},
            h("thead", {}, h("tr", {}, ["Time", "User", "Session", "Size"].map((t) => h("th", {}, t)))),
            h("tbody", {}, items.map((o) => h("tr", { class: "click", onclick: () => openRecord(o, nameOf[o.user] ?? o.user) },
              h("td", {}, fmt(Date.parse(o.lastModified))), h("td", {}, nameOf[o.user] ?? o.user), h("td", { class: "mono" }, o.session), h("td", {}, kb(o.size)))))))
        : h("p", { class: "muted" }, "No records found."))
    } catch (ex) { out.replaceChildren(h("p", { class: "err" }, ex.message)) }
  }
  userSel.addEventListener("change", load)
  dateIn.addEventListener("change", load)
  main.replaceChildren(
    h("div", { class: "bar" }, h("h2", {}, "Audit log"), h("span", { class: "spacer" }), userSel, dateIn,
      h("button", { class: "btn", onclick: load }, "Refresh")),
    out)
  load()
}

async function openRecord(o, who) {
  const body = h("div", {}, h("p", { class: "muted" }, "Loading…"))
  const dlg = modal("Turn · " + who, body, { wide: true })
  try {
    const r = await api("GET", "/audit/record?" + new URLSearchParams({ key: o.key }))
    const tokens = r.response?.tokens
    body.replaceChildren(
      h("div", { class: "kv" },
        h("span", {}, "Time"), h("span", {}, r.timestamp), h("span", {}, "Model"), h("span", {}, `${r.provider ?? "?"} / ${r.model ?? "?"}`),
        h("span", {}, "Agent"), h("span", {}, r.agent ?? "—"), h("span", {}, "Project"), h("span", { class: "mono" }, r.project?.directory ?? "—"),
        h("span", {}, "Host"), h("span", {}, `${r.user?.username ?? "?"}@${r.user?.hostname ?? "?"}`),
        h("span", {}, "Tokens"), h("span", {}, tokens ? `in ${tokens.input ?? 0} · out ${tokens.output ?? 0} · reasoning ${tokens.reasoning ?? 0}` : "—")),
      h("h2", {}, "Prompt"), h("pre", {}, r.prompt?.text ?? ""),
      h("h2", {}, "Response"), h("pre", {}, r.response?.text ?? ""),
      r.tools?.length ? [h("h2", {}, `Tool calls (${r.tools.length})`), r.tools.map((t) => h("div", {}, h("strong", {}, t.tool), h("pre", {}, JSON.stringify(t.args, null, 2) + (t.output ? "\n\n" + t.output : ""))))] : null,
      h("details", {}, h("summary", {}, "Raw JSON"), h("pre", {}, JSON.stringify(r, null, 2))),
      h("div", { class: "row" }, h("button", { class: "btn", onclick: () => dlg.close() }, "Close")))
  } catch (ex) { body.replaceChildren(h("p", { class: "err" }, ex.message)) }
}

// ---------- boot

api("GET", "/providers").then(start, renderLogin)

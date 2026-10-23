export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/admin/login" && request.method === "POST") {
      const body = await request.json();
      if (!body.password || body.password !== env.ADMIN_PASSWORD) {
        return json({ error: "Invalid password" }, 401);
      }
      const token = await signSession(env.ADMIN_SESSION_SECRET);
      return new Response(JSON.stringify({ success: true }), {
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": "moduscribe_session=" + token + "; HttpOnly; Path=/; Max-Age=86400; SameSite=Strict; Secure",
        },
      });
    }

    if (path === "/api/admin/logout" && request.method === "POST") {
      return new Response(JSON.stringify({ success: true }), {
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": "moduscribe_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict; Secure",
        },
      });
    }

    if (path === "/api/admin/session" && request.method === "GET") {
      const ok = await checkSession(request, env.ADMIN_SESSION_SECRET);
      return json({ authenticated: ok });
    }

    if (path === "/api/projects" && request.method === "GET") {
      const projects = (await env.MODUSCRIBE_KV.get("projects", "json")) || defaultProjects;
      return json(projects);
    }

    if (path.indexOf("/api/admin/projects") === 0) {
      const ok = await checkSession(request, env.ADMIN_SESSION_SECRET);
      if (!ok) return json({ error: "Unauthorized" }, 401);

      if (path === "/api/admin/projects" && request.method === "GET") {
        const projects = (await env.MODUSCRIBE_KV.get("projects", "json")) || defaultProjects;
        return json(projects);
      }

      if (path === "/api/admin/projects" && request.method === "POST") {
        const body = await request.json();
        const projects = (await env.MODUSCRIBE_KV.get("projects", "json")) || defaultProjects;
        const newProject = {
          id: crypto.randomUUID(),
          title: body.title || "Untitled",
          tag: body.tag || "Project",
          desc: body.desc || "",
          image: body.image || "",
          url: body.url || "#",
          color: body.color || "from-amber-200 to-amber-400",
          createdAt: Date.now(),
        };
        projects.unshift(newProject);
        await env.MODUSCRIBE_KV.put("projects", JSON.stringify(projects));
        return json(newProject);
      }

      if (path.indexOf("/api/admin/projects/") === 0 && request.method === "PUT") {
        const id = path.split("/").pop();
        const body = await request.json();
        const projects = (await env.MODUSCRIBE_KV.get("projects", "json")) || defaultProjects;
        const idx = projects.findIndex(function (p) { return p.id === id; });
        if (idx === -1) return json({ error: "Not found" }, 404);
        projects[idx] = Object.assign({}, projects[idx], body, { id: id });
        await env.MODUSCRIBE_KV.put("projects", JSON.stringify(projects));
        return json(projects[idx]);
      }

      if (path.indexOf("/api/admin/projects/") === 0 && request.method === "DELETE") {
        const id = path.split("/").pop();
        const projects = (await env.MODUSCRIBE_KV.get("projects", "json")) || defaultProjects;
        await env.MODUSCRIBE_KV.put("projects", JSON.stringify(projects.filter(function (p) { return p.id !== id; })));
        return json({ success: true });
      }
    }

    if (path === "/api/admin/upload" && request.method === "POST") {
      const ok = await checkSession(request, env.ADMIN_SESSION_SECRET);
      if (!ok) return json({ error: "Unauthorized" }, 401);

      const formData = await request.formData();
      const file = formData.get("file");
      if (!file) return json({ error: "No file" }, 400);

      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      const key = "project-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "." + ext;
      await env.MODUSCRIBE_R2.put(key, file.stream(), {
        httpMetadata: { contentType: file.type || "image/jpeg" },
      });
      return json({ url: "/img/" + key });
    }

    if (path.indexOf("/img/") === 0) {
      const key = path.replace("/img/", "");
      const obj = await env.MODUSCRIBE_R2.get(key);
      if (!obj) return new Response("Not found", { status: 404 });
      return new Response(obj.body, {
        headers: {
          "Content-Type": obj.httpMetadata && obj.httpMetadata.contentType ? obj.httpMetadata.contentType : "image/jpeg",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    }

    if (path === "/api/book" && request.method === "POST") {
      try {
        const body = await request.json();
        const name = body.name, email = body.email, type = body.type, budget = body.budget, message = body.message;
        if (!name || !email || !message) return json({ error: "Missing required fields" }, 400);

        const resendRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + env.RESEND_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: "ModuScribe <hello@moduscribe.app>",
            to: ["hello@moduscribe.com"],
            subject: "New Booking: " + name + " (" + type + ")",
            html: "<h2>New Project Inquiry</h2><p><strong>Name:</strong> " + name + "</p><p><strong>Email:</strong> " + email + "</p><p><strong>Type:</strong> " + type + "</p><p><strong>Budget:</strong> " + budget + "</p><p><strong>Message:</strong></p><p>" + String(message).replace(/\n/g, "<br>") + "</p>",
          }),
        });
        if (!resendRes.ok) return json({ error: "Email failed" }, 500);
        return json({ success: true });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    return new Response(HTML_PAGE, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function signSession(secret) {
  const payload = "admin:" + Date.now();
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const sigHex = Array.from(new Uint8Array(sig)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  return btoa(payload + "|" + sigHex);
}

async function checkSession(request, secret) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/moduscribe_session=([^;]+)/);
  if (!match) return false;
  try {
    const decoded = atob(match[1]);
    const parts = decoded.split("|");
    const payload = parts[0];
    const sigHex = parts[1];
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const expected = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
    const expectedHex = Array.from(new Uint8Array(expected)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    return expectedHex === sigHex;
  } catch (e) {
    return false;
  }
}

const defaultProjects = [
  { id: "1", title: "Tanda Coffee Co.", tag: "E-commerce", desc: "A small-batch coffee roaster with online ordering and subscription billing.", color: "from-amber-200 to-amber-400", image: "", url: "#" },
  { id: "2", title: "Nairobi Legal Aid", tag: "Nonprofit", desc: "A resource hub for free legal help, with a searchable directory and intake form.", color: "from-emerald-200 to-emerald-400", image: "", url: "#" },
  { id: "3", title: "Kito Fitness", tag: "Booking site", desc: "Class schedules, trainer profiles, and a simple booking flow with Stripe.", color: "from-rose-200 to-rose-400", image: "", url: "#" },
  { id: "4", title: "Mwangaza Tutoring", tag: "Education", desc: "Tutor marketplace with filters, reviews, and a parent-friendly signup.", color: "from-sky-200 to-sky-400", image: "", url: "#" },
];

const HTML_PAGE =
'<!DOCTYPE html>' +
'<html lang="en">' +
'<head>' +
'<meta charset="UTF-8" />' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0" />' +
'<title>ModuScribe — Websites that work</title>' +
'<script src="https://cdn.tailwindcss.com"></script>' +
'<script>tailwind.config={theme:{extend:{colors:{ink:"#0f172a",paper:"#faf8f3",accent:"#b45309",line:"#e7e2d6"},fontFamily:{serif:["Georgia","Cambria","serif"],sans:["Inter","system-ui","sans-serif"]}}}};</script>' +
'<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>' +
'<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>' +
'<script src="https://unpkg.com/@babel/standalone@7/babel.min.js"></script>' +
'<script src="https://unpkg.com/lucide@latest"></script>' +
'<style>html{scroll-behavior:smooth}body{background:#faf8f3}.rule{border-top:1px solid #e7e2d6}.fade-in{animation:fadeIn .5s ease both}@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}</style>' +
'</head>' +
'<body>' +
'<div id="root"></div>' +
'<script type="text/babel">' +
'const { useState, useEffect, useRef, useCallback } = React;' +
'const h = React.createElement;' +
'function Icon(props) {' +
'  var ref = useRef(null);' +
'  useEffect(function () {' +
'    if (ref.current && window.lucide) {' +
'      ref.current.innerHTML = "";' +
'      var el = document.createElement("i");' +
'      el.setAttribute("data-lucide", props.name);' +
'      ref.current.appendChild(el);' +
'      window.lucide.createIcons({ attrs: { width: props.size || 20, height: props.size || 20 } });' +
'    }' +
'  }, [props.name, props.size]);' +
'  return h("span", { ref: ref, className: "inline-flex items-center " + (props.className || "") });' +
'}' +
'function usePath() {' +
'  var s = useState(window.location.pathname || "/"); var path = s[0]; var setPath = s[1];' +
'  useEffect(function () {' +
'    var onPop = function () { setPath(window.location.pathname || "/"); };' +
'    window.addEventListener("popstate", onPop);' +
'    return function () { window.removeEventListener("popstate", onPop); };' +
'  }, []);' +
'  var navigate = function (to) {' +
'    if (to === window.location.pathname) return;' +
'    window.history.pushState({}, "", to);' +
'    setPath(to);' +
'    window.scrollTo({ top: 0 });' +
'  };' +
'  return [path, navigate];' +
'}' +
'function Nav(props) {' +
'  var links = [{ to: "/", label: "Home" }, { to: "/work", label: "Work" }, { to: "/about", label: "About" }, { to: "/book", label: "Book" }];' +
'  var s = useState(false); var open = s[0]; var setOpen = s[1];' +
'  return h("header", { className: "sticky top-0 z-40 bg-paper/90 backdrop-blur border-b border-line" },' +
'    h("div", { className: "max-w-7xl mx-auto px-6 py-4 flex items-center justify-between" },' +
'      h("button", { onClick: function () { props.navigate("/"); }, className: "flex items-center gap-2 group" },' +
'        h("span", { className: "w-8 h-8 rounded-full bg-ink text-paper flex items-center justify-center font-serif text-lg" }, "M"),' +
'        h("span", { className: "font-serif text-xl tracking-tight text-ink group-hover:text-accent transition" }, "ModuScribe")' +
'      ),' +
'      h("nav", { className: "hidden md:flex items-center gap-7 text-sm" },' +
'        links.map(function (l) {' +
'          return h("button", { key: l.to, onClick: function () { props.navigate(l.to); }, className: "transition " + (props.path === l.to ? "text-accent font-semibold" : "text-ink/70 hover:text-ink") }, l.label);' +
'        })' +
'      ),' +
'      h("button", { className: "md:hidden text-ink", onClick: function () { setOpen(!open); }, "aria-label": "Menu" },' +
'        h(Icon, { name: open ? "x" : "menu", size: 24 })' +
'      )' +
'    ),' +
'    open ? h("div", { className: "md:hidden border-t border-line bg-paper px-5 py-3 space-y-2" },' +
'      links.map(function (l) {' +
'        return h("button", { key: l.to, onClick: function () { props.navigate(l.to); setOpen(false); }, className: "block w-full text-left py-2 text-sm " + (props.path === l.to ? "text-accent font-semibold" : "text-ink/80") }, l.label);' +
'      })' +
'    ) : null' +
'  );' +
'}' +
'function Footer(props) {' +
'  return h("footer", { className: "rule mt-24" },' +
'    h("div", { className: "max-w-7xl mx-auto px-6 py-10 grid gap-8 sm:grid-cols-3 text-sm text-ink/70" },' +
'      h("div", null,' +
'        h("div", { className: "font-serif text-lg text-ink mb-2" }, "ModuScribe"),' +
'        h("p", null, "Classic websites, built carefully. Fast, responsive, and made to last.")' +
'      ),' +
'      h("div", null,' +
'        h("div", { className: "font-semibold text-ink mb-2" }, "Pages"),' +
'        h("ul", { className: "space-y-1" },' +
'          ["/", "/work", "/about", "/book"].map(function (p) {' +
'            return h("li", { key: p }, h("button", { onClick: function () { props.navigate(p); }, className: "hover:text-accent" }, p === "/" ? "Home" : p.slice(1).charAt(0).toUpperCase() + p.slice(2)));' +
'          })' +
'        )' +
'      ),' +
'      h("div", null,' +
'        h("div", { className: "font-semibold text-ink mb-2" }, "Contact"),' +
'        h("p", null, "hello@moduscribe.com")' +
'      )' +
'    ),' +
'    h("div", { className: "border-t border-line text-center text-xs text-ink/50 py-4" }, "© " + new Date().getFullYear() + " ModuScribe. All rights reserved.")' +
'  );' +
'}' +
'function ProjectCard(props) {' +
'  var p = props.p;' +
'  return h("a", { href: p.url, target: "_blank", rel: "noreferrer", className: "group block border border-line rounded-xl overflow-hidden bg-white hover:shadow-md transition" },' +
'    h("div", { className: "h-48 relative overflow-hidden " + (p.image ? "bg-white" : "bg-gradient-to-br " + (p.color || "from-amber-200 to-amber-400")) },' +
'      p.image' +
'        ? h("img", { src: p.image, alt: p.title, className: "w-full h-full object-cover group-hover:scale-105 transition duration-500" })' +
'        : h("span", { className: "absolute inset-0 flex items-center justify-center font-serif text-ink/40 text-lg" }, p.title),' +
'      h("span", { className: "absolute top-3 right-3 text-[10px] uppercase tracking-widest bg-white/90 text-ink px-2 py-1 rounded z-10" }, p.tag)' +
'    ),' +
'    h("div", { className: "p-5" },' +
'      h("div", { className: "flex items-center justify-between" },' +
'        h("h3", { className: "font-semibold text-ink group-hover:text-accent transition" }, p.title),' +
'        h(Icon, { name: "arrow-up-right", size: 16, className: "text-ink/40 group-hover:text-accent" })' +
'      ),' +
'      h("p", { className: "text-sm text-ink/60 mt-1" }, p.desc)' +
'    )' +
'  );' +
'}' +
'function Home(props) {' +
'  var projects = props.projects;' +
'  return h("main", { className: "fade-in" },' +
'    h("section", { className: "max-w-7xl mx-auto px-6 pt-16 pb-20 md:pt-28 md:pb-32" },' +
'      h("p", { className: "text-accent font-mono text-xs tracking-widest uppercase mb-4" }, "Websites that work"),' +
'      h("h1", { className: "font-serif text-4xl md:text-6xl lg:text-7xl leading-tight text-ink max-w-4xl" }, "I build classic, responsive websites for people who need one done right."),' +
'      h("p", { className: "mt-6 text-lg text-ink/70 max-w-2xl" }, "ModuScribe is a one-person studio. No agencies, no bloat. Just clean sites that load fast, look timeless, and help your visitors do what they came to do."),' +
'      h("div", { className: "mt-8 flex flex-wrap gap-3" },' +
'        h("button", { onClick: function () { props.navigate("/book"); }, className: "inline-flex items-center gap-2 bg-ink text-paper px-5 py-3 rounded-full text-sm font-medium hover:bg-accent transition" }, h(Icon, { name: "calendar-check", size: 18 }), " Book a build"),' +
'        h("button", { onClick: function () { props.navigate("/work"); }, className: "inline-flex items-center gap-2 border border-ink/20 text-ink px-5 py-3 rounded-full text-sm font-medium hover:border-ink transition" }, h(Icon, { name: "arrow-right", size: 18 }), " See the work")' +
'      )' +
'    ),' +
'    h("section", { className: "max-w-7xl mx-auto px-6 py-16" },' +
'      h("div", { className: "flex items-end justify-between mb-8" },' +
'        h("h2", { className: "font-serif text-2xl md:text-3xl text-ink" }, "Recent work"),' +
'        h("button", { onClick: function () { props.navigate("/work"); }, className: "text-sm text-accent hover:underline flex items-center gap-1" }, "All projects ", h(Icon, { name: "arrow-up-right", size: 16 }))' +
'      ),' +
'      h("div", { className: "grid gap-6 sm:grid-cols-2 lg:grid-cols-3" }, projects.slice(0, 4).map(function (p) { return h(ProjectCard, { key: p.id, p: p }); }))' +
'    ),' +
'    h("section", { className: "max-w-7xl mx-auto px-6 py-16" },' +
'      h("div", { className: "bg-ink text-paper rounded-2xl p-8 md:p-12 flex flex-col md:flex-row items-start md:items-center justify-between gap-6" },' +
'        h("div", null,' +
'          h("h2", { className: "font-serif text-2xl md:text-3xl" }, "Have a project in mind?"),' +
'          h("p", { className: "text-paper/70 mt-2 text-sm max-w-md" }, "Tell me what you are building. I will reply within a day with a plan and a price.")' +
'        ),' +
'        h("button", { onClick: function () { props.navigate("/book"); }, className: "inline-flex items-center gap-2 bg-paper text-ink px-5 py-3 rounded-full text-sm font-medium hover:bg-accent hover:text-paper transition shrink-0" }, h(Icon, { name: "arrow-right", size: 18 }), " Start a project")' +
'      )' +
'    )' +
'  );' +
'}' +
'function Work(props) {' +
'  return h("main", { className: "max-w-7xl mx-auto px-6 py-20 fade-in" },' +
'    h("p", { className: "text-accent font-mono text-xs tracking-widest uppercase mb-3" }, "Portfolio"),' +
'    h("h1", { className: "font-serif text-4xl md:text-5xl text-ink" }, "Selected projects"),' +
'    h("p", { className: "mt-4 text-ink/70 max-w-2xl" }, "A few sites I have built for small businesses, nonprofits, and independent founders."),' +
'    h("div", { className: "mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3" }, props.projects.map(function (p) { return h(ProjectCard, { key: p.id, p: p }); }))' +
'  );' +
'}' +
'function About() {' +
'  return h("main", { className: "max-w-3xl mx-auto px-5 py-16 fade-in" },' +
'    h("p", { className: "text-accent font-mono text-xs tracking-widest uppercase mb-3" }, "About"),' +
'    h("h1", { className: "font-serif text-4xl md:text-5xl text-ink" }, "A one-person studio, on purpose."),' +
'    h("div", { className: "mt-8 space-y-5 text-ink/75 leading-relaxed" },' +
'      h("p", null, "My name is Ismael. I build websites for people who do not want a committee, a pitch deck, or a three-month wait."),' +
'      h("p", null, "I started ModuScribe because too many small businesses get sold heavy platforms they do not need. A clean, fast, five-page site will outperform a bloated one every time."),' +
'      h("p", null, "Every site I build is responsive, accessible, and hand-coded. You own it when it ships.")' +
'    )' +
'  );' +
'}' +
'function Book() {' +
'  var s1 = useState({ name: "", email: "", type: "Marketing site", budget: "$500 - $1,500", message: "" }); var form = s1[0]; var setForm = s1[1];' +
'  var s2 = useState(false); var sent = s2[0]; var setSent = s2[1];' +
'  var s3 = useState(""); var err = s3[0]; var setErr = s3[1];' +
'  var s4 = useState(false); var loading = s4[0]; var setLoading = s4[1];' +
'  var submit = function (e) {' +
'    e.preventDefault();' +
'    if (!form.name || !form.email || !form.message) { setErr("Please fill in your name, email, and a short message."); return; }' +
'    setErr(""); setLoading(true);' +
'    fetch("/api/book", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) })' +
'      .then(function (res) { if (res.ok) { setSent(true); } else { setErr("Something went wrong. Please email me at hello@moduscribe.com."); } setLoading(false); })' +
'      .catch(function () { setErr("Network error. Please try again."); setLoading(false); });' +
'  };' +
'  if (sent) {' +
'    return h("main", { className: "max-w-2xl mx-auto px-5 py-24 text-center fade-in" },' +
'      h("div", { className: "w-14 h-14 rounded-full bg-accent/10 text-accent flex items-center justify-center mx-auto mb-5" }, h(Icon, { name: "check", size: 28 })),' +
'      h("h1", { className: "font-serif text-3xl text-ink" }, "Thanks, " + form.name.split(" ")[0] + "."),' +
'      h("p", { className: "mt-3 text-ink/70" }, "Your request is in. I will reply to " + form.email + " within one business day.")' +
'    );' +
'  }' +
'  var field = "w-full border border-line rounded-lg px-4 py-3 bg-white text-ink text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent";' +
'  return h("main", { className: "max-w-2xl mx-auto px-5 py-16 fade-in" },' +
'    h("p", { className: "text-accent font-mono text-xs tracking-widest uppercase mb-3" }, "Book a build"),' +
'    h("h1", { className: "font-serif text-4xl md:text-5xl text-ink" }, "Tell me about your project."),' +
'    h("p", { className: "mt-4 text-ink/70" }, "A few details is all I need. I reply within one business day."),' +
'    h("form", { onSubmit: submit, className: "mt-8 space-y-4" },' +
'      h("div", { className: "grid gap-4 sm:grid-cols-2" },' +
'        h("div", null, h("label", { className: "block text-xs font-medium text-ink/70 mb-1" }, "Your name"), h("input", { className: field, value: form.name, onChange: function (e) { setForm(Object.assign({}, form, { name: e.target.value })); }, placeholder: "Jane Doe" })),' +
'        h("div", null, h("label", { className: "block text-xs font-medium text-ink/70 mb-1" }, "Email"), h("input", { type: "email", className: field, value: form.email, onChange: function (e) { setForm(Object.assign({}, form, { email: e.target.value })); }, placeholder: "jane@example.com" }))' +
'      ),' +
'      h("div", { className: "grid gap-4 sm:grid-cols-2" },' +
'        h("div", null, h("label", { className: "block text-xs font-medium text-ink/70 mb-1" }, "Project type"), h("select", { className: field, value: form.type, onChange: function (e) { setForm(Object.assign({}, form, { type: e.target.value })); } }, ["Marketing site", "Simple store", "Booking site", "Portfolio", "Other"].map(function (o) { return h("option", { key: o }, o); }))),' +
'        h("div", null, h("label", { className: "block text-xs font-medium text-ink/70 mb-1" }, "Budget"), h("select", { className: field, value: form.budget, onChange: function (e) { setForm(Object.assign({}, form, { budget: e.target.value })); } }, ["Under $500", "$500 - $1,500", "$1,500 - $3,000", "$3,000+"].map(function (o) { return h("option", { key: o }, o); })))' +
'      ),' +
'      h("div", null, h("label", { className: "block text-xs font-medium text-ink/70 mb-1" }, "What are you building?"), h("textarea", { rows: "5", className: field, value: form.message, onChange: function (e) { setForm(Object.assign({}, form, { message: e.target.value })); }, placeholder: "A few sentences about your site." })),' +
'      err ? h("p", { className: "text-sm text-red-600" }, err) : null,' +
'      h("button", { type: "submit", disabled: loading, className: "inline-flex items-center gap-2 bg-ink text-paper px-6 py-3 rounded-full text-sm font-medium hover:bg-accent transition disabled:opacity-50" }, h(Icon, { name: "send", size: 16 }), " " + (loading ? "Sending..." : "Send request"))' +
'    )' +
'  );' +
'}' +
'function Admin() {' +
'  var s1 = useState(null); var authed = s1[0]; var setAuthed = s1[1];' +
'  var s2 = useState(""); var password = s2[0]; var setPassword = s2[1];' +
'  var s3 = useState(""); var err = s3[0]; var setErr = s3[1];' +
'  var s4 = useState([]); var projects = s4[0]; var setProjects = s4[1];' +
'  var s5 = useState(false); var loading = s5[0]; var setLoading = s5[1];' +
'  var loadProjects = function () {' +
'    fetch("/api/admin/projects").then(function (r) { if (r.ok) return r.json(); }).then(function (d) { if (d) setProjects(d); });' +
'  };' +
'  useEffect(function () {' +
'    fetch("/api/admin/session").then(function (r) { return r.json(); }).then(function (d) { setAuthed(d.authenticated); if (d.authenticated) loadProjects(); });' +
'  }, []);' +
'  var login = function (e) {' +
'    e.preventDefault(); setLoading(true); setErr("");' +
'    fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: password }) })' +
'      .then(function (r) { if (r.ok) { setAuthed(true); loadProjects(); } else { setErr("Invalid password."); } setLoading(false); })' +
'      .catch(function () { setErr("Network error."); setLoading(false); });' +
'  };' +
'  var logout = function () {' +
'    fetch("/api/admin/logout", { method: "POST" }).then(function () { setAuthed(false); setProjects([]); setPassword(""); });' +
'  };' +
'  if (authed === null) return h("main", { className: "py-24 text-center text-ink/50" }, "Loading...");' +
'  if (!authed) {' +
'    return h("main", { className: "max-w-sm mx-auto px-5 py-24 fade-in" },' +
'      h("div", { className: "text-center mb-8" },' +
'        h("div", { className: "w-12 h-12 rounded-full bg-ink text-paper flex items-center justify-center font-serif text-xl mx-auto mb-4" }, "M"),' +
'        h("h1", { className: "font-serif text-2xl text-ink" }, "Admin login"),' +
'        h("p", { className: "text-sm text-ink/60 mt-1" }, "ModuScribe dashboard")' +
'      ),' +
'      h("form", { onSubmit: login, className: "space-y-3" },' +
'        h("input", { type: "password", value: password, onChange: function (e) { setPassword(e.target.value); }, placeholder: "Password", className: "w-full border border-line rounded-lg px-4 py-3 bg-white text-ink text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent", autoFocus: true }),' +
'        err ? h("p", { className: "text-sm text-red-600" }, err) : null,' +
'        h("button", { disabled: loading, className: "w-full bg-ink text-paper px-5 py-3 rounded-lg text-sm font-medium hover:bg-accent transition disabled:opacity-50" }, loading ? "Signing in..." : "Sign in")' +
'      )' +
'    );' +
'  }' +
'  return h("main", { className: "max-w-7xl mx-auto px-6 py-12 fade-in" },' +
'    h("div", { className: "flex items-center justify-between mb-8" },' +
'      h("div", null,' +
'        h("h1", { className: "font-serif text-3xl text-ink" }, "Portfolio dashboard"),' +
'        h("p", { className: "text-sm text-ink/60 mt-1" }, "Manage the projects shown on your site.")' +
'      ),' +
'      h("button", { onClick: logout, className: "inline-flex items-center gap-2 text-sm text-ink/60 hover:text-accent" }, h(Icon, { name: "log-out", size: 16 }), " Logout")' +
'    ),' +
'    h(AdminProjectForm, { onSaved: loadProjects }),' +
'    h(AdminProjectList, { projects: projects, onChanged: loadProjects })' +
'  );' +
'}' +
'function AdminProjectForm(props) {' +
'  var empty = { title: "", tag: "Project", desc: "", url: "", image: "", color: "from-amber-200 to-amber-400" };' +
'  var s1 = useState(props.editing || empty); var form = s1[0]; var setForm = s1[1];' +
'  var s2 = useState(false); var uploading = s2[0]; var setUploading = s2[1];' +
'  var s3 = useState(false); var saving = s3[0]; var setSaving = s3[1];' +
'  var s4 = useState(""); var err = s4[0]; var setErr = s4[1];' +
'  useEffect(function () { setForm(props.editing || empty); }, [props.editing]);' +
'  var upload = function (e) {' +
'    var file = e.target.files[0]; if (!file) return;' +
'    setUploading(true);' +
'    var fd = new FormData(); fd.append("file", file);' +
'    fetch("/api/admin/upload", { method: "POST", body: fd })' +
'      .then(function (res) { if (res.ok) return res.json(); throw new Error("upload failed"); })' +
'      .then(function (d) { setForm(Object.assign({}, form, { image: d.url })); setUploading(false); })' +
'      .catch(function () { setErr("Upload failed. Check R2 binding."); setUploading(false); });' +
'  };' +
'  var save = function (e) {' +
'    e.preventDefault(); setSaving(true); setErr("");' +
'    var isEdit = !!form.id;' +
'    fetch(isEdit ? "/api/admin/projects/" + form.id : "/api/admin/projects", {' +
'      method: isEdit ? "PUT" : "POST",' +
'      headers: { "Content-Type": "application/json" },' +
'      body: JSON.stringify(form)' +
'    }).then(function (res) {' +
'      if (res.ok) { setForm(empty); if (props.onCancel) props.onCancel(); props.onSaved(); } else { setErr("Save failed."); }' +
'      setSaving(false);' +
'    }).catch(function () { setErr("Save failed."); setSaving(false); });' +
'  };' +
'  var field = "w-full border border-line rounded-lg px-3 py-2 bg-white text-ink text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent";' +
'  return h("form", { onSubmit: save, className: "bg-white border border-line rounded-xl p-5 mb-8 space-y-4" },' +
'    h("h2", { className: "font-semibold text-ink" }, props.editing ? "Edit project" : "Add new project"),' +
'    h("div", { className: "grid gap-3 sm:grid-cols-2" },' +
'      h("input", { className: field, placeholder: "Title", value: form.title, onChange: function (e) { setForm(Object.assign({}, form, { title: e.target.value })); }, required: true }),' +
'      h("input", { className: field, placeholder: "Tag (e.g. E-commerce)", value: form.tag, onChange: function (e) { setForm(Object.assign({}, form, { tag: e.target.value })); } })' +
'    ),' +
'    h("textarea", { className: field, rows: "2", placeholder: "Short description", value: form.desc, onChange: function (e) { setForm(Object.assign({}, form, { desc: e.target.value })); } }),' +
'    h("div", { className: "grid gap-3 sm:grid-cols-2" },' +
'      h("input", { className: field, placeholder: "Live URL (https://...)", value: form.url, onChange: function (e) { setForm(Object.assign({}, form, { url: e.target.value })); } }),' +
'      h("div", null,' +
'        h("label", { className: "block text-xs text-ink/60 mb-1" }, "Screenshot"),' +
'        h("input", { type: "file", accept: "image/*", onChange: upload, className: "text-xs" }),' +
'        uploading ? h("p", { className: "text-xs text-accent mt-1" }, "Uploading...") : null' +
'      )' +
'    ),' +
'    form.image ? h("div", { className: "flex items-center gap-3" },' +
'      h("img", { src: form.image, alt: "", className: "w-20 h-14 object-cover rounded border border-line" }),' +
'      h("button", { type: "button", onClick: function () { setForm(Object.assign({}, form, { image: "" })); }, className: "text-xs text-red-600 hover:underline" }, "Remove image")' +
'    ) : null,' +
'    err ? h("p", { className: "text-sm text-red-600" }, err) : null,' +
'    h("div", { className: "flex gap-2" },' +
'      h("button", { disabled: saving, className: "inline-flex items-center gap-2 bg-ink text-paper px-5 py-2.5 rounded-full text-sm font-medium hover:bg-accent transition disabled:opacity-50" }, h(Icon, { name: props.editing ? "save" : "plus", size: 16 }), " " + (saving ? "Saving..." : (props.editing ? "Save changes" : "Add project"))),' +
'      props.editing ? h("button", { type: "button", onClick: props.onCancel, className: "px-4 py-2.5 text-sm text-ink/60 hover:text-ink" }, "Cancel") : null' +
'    )' +
'  );' +
'}' +
'function AdminProjectList(props) {' +
'  var s1 = useState(null); var editing = s1[0]; var setEditing = s1[1];' +
'  var s2 = useState(null); var deleting = s2[0]; var setDeleting = s2[1];' +
'  var del = function (id) {' +
'    if (!confirm("Delete this project?")) return;' +
'    setDeleting(id);' +
'    fetch("/api/admin/projects/" + id, { method: "DELETE" }).then(function () { setDeleting(null); props.onChanged(); });' +
'  };' +
'  if (editing) {' +
'    return h(AdminProjectForm, { editing: editing, onSaved: function () { setEditing(null); props.onChanged(); }, onCancel: function () { setEditing(null); } });' +
'  }' +
'  return h("div", { className: "bg-white border border-line rounded-xl overflow-hidden" },' +
'    h("div", { className: "px-5 py-3 border-b border-line flex items-center justify-between" },' +
'      h("h2", { className: "font-semibold text-ink" }, "Projects (" + props.projects.length + ")")' +
'    ),' +
'    props.projects.length === 0' +
'      ? h("p", { className: "p-5 text-sm text-ink/50" }, "No projects yet. Add one above.")' +
'      : h("ul", { className: "divide-y divide-line" },' +
'          props.projects.map(function (p) {' +
'            return h("li", { key: p.id, className: "flex items-center gap-4 p-4" },' +
'              h("div", { className: "w-16 h-12 rounded border border-line overflow-hidden bg-ink/5 flex items-center justify-center shrink-0" },' +
'                p.image ? h("img", { src: p.image, alt: "", className: "w-full h-full object-cover" }) : h("span", { className: "text-[10px] text-ink/40" }, p.tag)' +
'              ),' +
'              h("div", { className: "flex-1 min-w-0" },' +
'                h("div", { className: "font-medium text-ink text-sm truncate" }, p.title),' +
'                h("div", { className: "text-xs text-ink/50 truncate" }, p.desc)' +
'              ),' +
'              h("div", { className: "flex gap-1 shrink-0" },' +
'                h("button", { onClick: function () { setEditing(p); }, className: "p-2 text-ink/50 hover:text-accent", "aria-label": "Edit" }, h(Icon, { name: "pencil", size: 16 })),' +
'                h("button", { onClick: function () { del(p.id); }, disabled: deleting === p.id, className: "p-2 text-ink/50 hover:text-red-600 disabled:opacity-40", "aria-label": "Delete" }, h(Icon, { name: "trash-2", size: 16 }))' +
'              )' +
'            );' +
'          })' +
'        )' +
'  );' +
'}' +
'function NotFound(props) {' +
'  return h("main", { className: "max-w-2xl mx-auto px-5 py-24 text-center fade-in" },' +
'    h("h1", { className: "font-serif text-6xl text-ink" }, "404"),' +
'    h("p", { className: "mt-3 text-ink/70" }, "That page does not exist."),' +
'    h("button", { onClick: function () { props.navigate("/"); }, className: "mt-6 inline-flex items-center gap-2 bg-ink text-paper px-5 py-3 rounded-full text-sm font-medium hover:bg-accent transition" }, h(Icon, { name: "home", size: 16 }), " Back home")' +
'  );' +
'}' +
'function App() {' +
'  var p = usePath(); var path = p[0]; var navigate = p[1];' +
'  var s = useState([]); var projects = s[0]; var setProjects = s[1];' +
'  useEffect(function () {' +
'    if (path === "/admin") return;' +
'    fetch("/api/projects").then(function (r) { return r.json(); }).then(setProjects).catch(function () {});' +
'  }, [path]);' +
'  if (path === "/admin") return h(Admin);' +
'  var Page;' +
'  if (path === "/") Page = h(Home, { navigate: navigate, projects: projects });' +
'  else if (path === "/work") Page = h(Work, { projects: projects });' +
'  else if (path === "/about") Page = h(About);' +
'  else if (path === "/book") Page = h(Book);' +
'  else Page = h(NotFound, { navigate: navigate });' +
'  return h("div", { className: "min-h-screen flex flex-col" },' +
'    h(Nav, { navigate: navigate, path: path }),' +
'    h("div", { className: "flex-1" }, Page),' +
'    h(Footer, { navigate: navigate })' +
'  );' +
'}' +
'ReactDOM.createRoot(document.getElementById("root")).render(h(App));' +
'</script>' +
'</body>' +
'</html>'; 

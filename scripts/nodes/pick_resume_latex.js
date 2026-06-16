// Pick Resume LaTeX — S6b-4. Convergence before Compile: use the regenerated resume
// if the ATS-low retry ran this execution, else the original assembly. Exactly one of
// the two upstream branches fires per run; n8n throws on $('<unrun node>') (caught).
// Out: { latex, chat_id, job_title, company, resumePlainText } (Compile reads .latex).
let r = null;
try { const a = $('Assemble Regen').first().json; if (a && a.latex) r = a; } catch (e) {}
if (!r) { try { const o = $('Assemble Resume LaTeX').first().json; if (o && o.latex) r = o; } catch (e) {} }
r = r || {};
return [{ json: { latex: r.latex, chat_id: r.chat_id, job_title: r.job_title, company: r.company, resumePlainText: r.resumePlainText } }];

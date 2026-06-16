// Finalize Enriched Contact — S8. Converge after the Hunter gate. Attaches the
// Hunter deliverability result (if Hunter ran) to the enriched contact, then hands
// the Load-Draft-Contact-shaped object (+ enrichment) to the hook lane. Graceful:
// if Hunter didn't run, email_verified stays null ("unverified"). $('<unrun>') caught.
const ctx = $('Build Enriched Contact').first().json || {};
const contact = ctx.contact || {};

let status = null, verified = null;
try {
  const h = $('Hunter Verify').first().json || {};
  status = h.status || h.result || (h.data && h.data.status) || null;
  if (status) verified = ['valid', 'deliverable', 'accept_all', 'webmail'].indexOf(String(status).toLowerCase()) !== -1;
} catch (e) { status = null; verified = null; }

const enrichedContact = Object.assign({}, contact, { email_status: status, email_verified: verified });

return [{ json: Object.assign({}, ctx, {
  contact: enrichedContact,
  email_verified: verified,
  enriched: !!(contact.apollo_enriched || status),
}) }];

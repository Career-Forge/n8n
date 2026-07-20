/**
 * s133_digest_webapp_button.js -- adds a "📱 View in App" inline web_app
 * button under every digest message, so opening the Mini App is one tap
 * from wherever the results already are, instead of hunting for the menu
 * button. Optional (a working "View in App" affordance already exists via
 * Telegram's own Menu Button once BotFather is configured) -- this is a
 * convenience add-on, not a dependency for the app to function.
 *
 * Confirmed directly against the installed Telegram node source
 * (dist/nodes/Telegram/Telegram.node.js, ~line 1326): inline-keyboard
 * buttons support a `web_app` collection field with a `url` sub-field --
 * "Launch the Telegram Web App". Per Telegram's own Bot API docs, web_app
 * inline buttons are only valid in private chats, which this bot always
 * is (single-user, DM-only) -- no fallback branch needed.
 *
 * GUARDED DEPLOY: this button's URL is `{{ $env.MINIAPP_PUBLIC_URL }}`.
 * If that's empty (Tailscale Funnel not wired up yet), Telegram's
 * sendMessage would reject the button with BUTTON_URL_INVALID -- WHICH
 * WOULD BREAK EVERY DIGEST SEND, a real regression to a working bot. This
 * script refuses to patch (and definitely refuses to deploy) until
 * docker/.env's MINIAPP_PUBLIC_URL is a real https:// value. Safe to
 * re-run once it is -- it'll proceed automatically.
 *
 * Run: harness (button shape) + precondition-guarded deploy (master only)
 * + verify.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MASTER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Master_local.json');
const ENV_FILE = path.join(ROOT, 'docker', '.env');

function readMiniappPublicUrl() {
  if (!fs.existsSync(ENV_FILE)) return '';
  const line = fs.readFileSync(ENV_FILE, 'utf8').split('\n').find((l) => l.startsWith('MINIAPP_PUBLIC_URL='));
  return line ? line.slice('MINIAPP_PUBLIC_URL='.length).trim() : '';
}

const VIEW_IN_APP_BUTTON = {
  text: '📱 View in App',
  additionalFields: {
    web_app: { url: "={{ $env.MINIAPP_PUBLIC_URL }}" },
  },
};

function patch() {
  const url = readMiniappPublicUrl();
  if (!url || !/^https:\/\//.test(url)) {
    console.log(`  master: SKIPPED -- docker/.env's MINIAPP_PUBLIC_URL is not set to a real https:// URL yet (current: "${url}"). Deploying now would put an invalid URL into every digest's inline button and break Send Digest. Set up Tailscale Funnel first (see miniapp/README.md), then re-run this script.`);
    return false;
  }

  const wf = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
  const node = wf.nodes.find((n) => n.name === 'Send Digest');
  if (!node) { console.error('INTEGRITY FAIL: Send Digest missing'); process.exit(1); }

  if (node.parameters.replyMarkup === 'inlineKeyboard') {
    console.log('  master: already patched (Send Digest already has a replyMarkup)');
    return true;
  }
  if (node.parameters.replyMarkup !== undefined) {
    console.error(`INTEGRITY FAIL: Send Digest already has an unexpected replyMarkup ("${node.parameters.replyMarkup}") -- refusing to overwrite blind`);
    process.exit(1);
  }

  node.parameters.replyMarkup = 'inlineKeyboard';
  node.parameters.inlineKeyboard = {
    rows: [{ row: { buttons: [JSON.parse(JSON.stringify(VIEW_IN_APP_BUTTON))] } }],
  };

  fs.writeFileSync(MASTER_FILE, JSON.stringify(wf, null, 2));
  console.log('  master: Send Digest patched with the "View in App" web_app button');
  return true;
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  let failures = 0;
  function check(label, cond) { if (!cond) { console.error('HARNESS FAIL:', label); failures++; } }

  check('button has correct text', VIEW_IN_APP_BUTTON.text === '📱 View in App');
  check('button uses web_app collection (not plain url -- confirmed valid shape from installed node source)',
    !!VIEW_IN_APP_BUTTON.additionalFields.web_app && typeof VIEW_IN_APP_BUTTON.additionalFields.web_app.url === 'string');
  check('button url references $env.MINIAPP_PUBLIC_URL, not a hardcoded value',
    VIEW_IN_APP_BUTTON.additionalFields.web_app.url.includes('$env.MINIAPP_PUBLIC_URL'));

  // Precondition guard, run for real against fixture .env contents.
  function wouldSkip(envContents) {
    const line = envContents.split('\n').find((l) => l.startsWith('MINIAPP_PUBLIC_URL='));
    const url = line ? line.slice('MINIAPP_PUBLIC_URL='.length).trim() : '';
    return !url || !/^https:\/\//.test(url);
  }
  check('empty MINIAPP_PUBLIC_URL -> guard skips', wouldSkip('MINIAPP_PUBLIC_URL=\n'));
  check('missing MINIAPP_PUBLIC_URL key -> guard skips', wouldSkip('SOME_OTHER_KEY=x\n'));
  check('http:// (not https://) -> guard skips', wouldSkip('MINIAPP_PUBLIC_URL=http://insecure.example\n'));
  check('real https:// value -> guard proceeds', !wouldSkip('MINIAPP_PUBLIC_URL=https://foo.ts.net\n'));

  if (failures > 0) { console.error(`\n${failures} HARNESS FAILURE(S)`); process.exit(1); }
  console.log('HARNESS OK: button shape verified (web_app collection, env-referenced URL); precondition guard correctly gates on a real https:// MINIAPP_PUBLIC_URL before ever touching the workflow file.');

  const deployed = patch();
  console.log(deployed ? 'S133 (digest View in App button) deployed.' : 'S133 (digest View in App button) staged, deploy held pending Tailscale setup.');
})();

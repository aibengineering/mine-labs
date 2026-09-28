/**
 * The page a phone opens to join a lab in Tailscale remote mode.
 *
 * It is the whole setup in one place: the lab address to enter, the exact mod
 * files this catalog needs, and launcher steps. Amethyst, the Android launcher
 * that continues PojavLauncher, is the target, so the steps use its labels.
 *
 * The lab serves plain HTTP on a tailnet address, which browsers do not treat
 * as a secure context, so the Clipboard API is usually missing. Copying falls
 * back to selecting the address field, which works over HTTP.
 */
import { stat } from "node:fs/promises";

export interface SetupDownload {
  name: string;
  bytes: number;
}

export async function describeDownloads(downloads: readonly { name: string; path: string }[]): Promise<SetupDownload[]> {
  return Promise.all(downloads.map(async ({ name, path }) => ({ name, bytes: (await stat(path)).size })));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => `&#${character.charCodeAt(0)};`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STYLE = `
:root{--bg:#f6f6f4;--card:#ffffff;--text:#1d1d1f;--muted:#5f6368;--line:#dedcd6;--accent:#2f6f4f;--accent-text:#ffffff;--code:#efeee9}
@media (prefers-color-scheme:dark){:root{--bg:#141514;--card:#1d1f1d;--text:#ececea;--muted:#a5a8a3;--line:#343733;--accent:#6fbf8e;--accent-text:#0d1a12;--code:#262926}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:40rem;margin:0 auto;padding:20px 16px 48px}
h1{font-size:1.6rem;margin:0 0 4px}
h2{font-size:1.1rem;margin:0 0 10px}
p{margin:0 0 10px}
.lede{color:var(--muted);margin-bottom:20px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:0 0 16px}
.address{display:flex;gap:8px}
.address input{flex:1;min-width:0;font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.95rem;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--code);color:var(--text)}
button,.download{font:inherit;font-weight:600;border:0;border-radius:8px;padding:10px 14px;background:var(--accent);color:var(--accent-text);text-decoration:none;cursor:pointer;white-space:nowrap}
.status{min-height:1.4em;color:var(--muted);font-size:.9rem;margin:6px 0 0}
ul.mods{list-style:none;margin:0;padding:0}
ul.mods li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--line)}
ul.mods li:first-child{border-top:0;padding-top:0}
.name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9rem;word-break:break-all}
.size{display:block;color:var(--muted);font-size:.85rem;font-family:inherit}
ol{margin:0;padding-left:1.3rem}
ol li{margin:0 0 10px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;background:var(--code);padding:1px 4px;border-radius:4px;word-break:break-word}
.note{color:var(--muted);font-size:.9rem;margin-top:10px}
a{color:var(--accent)}
details{margin-top:12px}
summary{cursor:pointer;font-weight:600}
details ul{margin:8px 0 0;padding-left:1.2rem}
details li{margin:0 0 8px}
`;

const COPY_SCRIPT = `
(function(){
  var field=document.getElementById("lab-address");
  var status=document.getElementById("copy-status");
  document.getElementById("copy-address").addEventListener("click",function(){
    function copied(){status.textContent="Copied. Enter it on Minecraft's Mine Labs screen.";}
    function fallback(){
      field.focus();field.select();field.setSelectionRange(0,field.value.length);
      var ok=false;try{ok=document.execCommand("copy");}catch(e){}
      if(ok)copied();else status.textContent="Select the address above and copy it.";
    }
    if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(field.value).then(copied,fallback);}
    else fallback();
  });
})();
`;

/**
 * Amethyst steps, using its own labels (checked against its source, 1.1.7).
 *
 * Amethyst only allows modded profiles and "Open game directory" once a
 * Microsoft account that owns Java Edition is signed in, so that comes first.
 * Loader profiles share the default `.minecraft`, whose `mods` folder Amethyst
 * exposes to Android's Files app through its "Amethyst" documents provider.
 */
function amethystSteps(url: string, downloads: readonly SetupDownload[]): string {
  const files = downloads.map(({ name }) => `<code>${escapeHtml(name)}</code>`).join(", ");
  return `<ol>
<li><b>Install Amethyst</b> from its <a href="https://github.com/AngelAuraMC/Amethyst-Android/releases/latest">GitHub releases</a> (<code>Amethyst.apk</code>). It is not on Google Play; other download sites are unofficial.</li>
<li><b>Sign in.</b> Open the account menu, tap <b>Add account</b>, then <b>Microsoft Account</b>. Amethyst needs a Microsoft account that owns Minecraft: Java Edition before it allows modded profiles. The lab watches for whichever player you sign in as.</li>
<li><b>Create the NeoForge profile.</b> Open the profile menu, tap <b>Create new profile</b>, then under Modded versions tap <b>Create Neoforge profile</b>. Expand <b>1.21.4</b> and pick <b>21.4.157</b> or newer. Wait for the installer log to finish.</li>
<li><b>Launch it once</b> with <b>Play</b>, so Amethyst downloads the game and Java 21 and creates the <code>mods</code> folder. Close the game when the title screen appears.</li>
<li><b>Add the mods.</b> Download ${files} above. In Android's Files app, open Downloads, select those files and choose <b>Copy</b>. Open the side menu, choose <b>Amethyst</b>, open <code>.minecraft</code> then <code>mods</code>, and paste. Amethyst's <b>Open game directory</b> button opens the same place.</li>
<li><b>Connect.</b> Launch the profile again and tap <b>Mine Labs</b>, under the title screen's menu buttons (it is also beside Multiplayer's <b>Direct Connection</b>). Enter <code>${escapeHtml(url)}</code> and tap <b>Connect</b>. The address is saved, so later launches open the dashboard directly.</li>
</ol>
<p class="note">Enter the address on the Mine Labs screen, not as a Multiplayer server: it is the lab's dashboard, and the mod joins each scenario world for you.</p>
<p class="note">No function keys needed. In a scenario world, tap Amethyst's on-screen <b>Pause</b> button: <b>Mine Labs</b>, <b>Return to Labs</b> and <b>Teleport to bot</b> sit under the pause menu. The dashboard has <b>Start scenario</b> and <b>Scenario details</b> buttons, and <b>Exit Menu</b> closes it.</p>`;
}

function troubleshooting(): string {
  return `<details><summary>If something goes wrong</summary><ul>
<li><b>"No Minecraft Account Found"</b>: sign in with the Microsoft account first (step 2).</li>
<li><b>Black screen or a graphics crash</b>: edit the profile with the pencil button and set <b>Renderer</b> to Krypton Wrapper or MobileGlues.</li>
<li><b>Laggy</b>: in Minecraft, set Options → Video Settings → <b>Render Distance</b> to 4–6 and close other apps. The lab worlds are small, so a short render distance loses little.</li>
<li><b>Runs out of memory</b>: raise Settings → <b>Java Tweaks</b> → <b>Memory allocation</b>; 2–4 GB suits most phones, but leave Android some free memory.</li>
<li><b>The dashboard says the lab is offline</b>: check that Tailscale is connected on this device and that the lab is still running.</li>
<li><b>No Amethyst in the Files app's side menu</b>: some manufacturers' file apps hide it. Use the <b>Open game directory</b> button instead.</li>
</ul></details>`;
}

export function setupPage(url: string, downloads: readonly SetupDownload[]): string {
  const mods = downloads.map(({ name, bytes }) => `<li><span class="name">${escapeHtml(name)}<span class="size">${formatBytes(bytes)}</span></span>`
    + `<a class="download" href="/downloads/${encodeURIComponent(name)}" download>Download</a></li>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mine Labs Setup</title><style>${STYLE}</style></head>
<body><main>
<h1>Mine Labs setup</h1>
<p class="lede">Watch and run this lab's scenarios from Minecraft on this device, over Tailscale.</p>
<section><h2>Lab address</h2>
<div class="address"><input id="lab-address" readonly value="${escapeHtml(url)}" aria-label="Lab address"><button id="copy-address" type="button">Copy</button></div>
<p class="status" id="copy-status" role="status"></p></section>
<section><h2>Mods</h2><ul class="mods">${mods}</ul>
<p class="note">Download them again whenever the lab says its mods changed.</p></section>
<section><h2>Set up Amethyst</h2>${amethystSteps(url, downloads)}${troubleshooting()}</section>
</main><script>${COPY_SCRIPT}</script></body></html>`;
}

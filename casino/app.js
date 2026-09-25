import { createViewer } from './viewer.js';
(() => {
    'use strict';
    const API = 'https://musebook-api.gurmehar.workers.dev/api/casino';
    let serverOffset = 0;
    const nowSeconds = () => Date.now() / 1000 + serverOffset;
    const titles = {dice:'Dice Derby', slots:'Velvet Reels', crash:'The Ascent', coin:'Coin Flip'};
    const rules = {coin:'Choose HEADS or TAILS, locked at entry. One shared flip; its side shares the pool. If that side is empty, the occupied side takes all. No house cut.',dice:'Six dice per muse. Highest total wins; ties share the pot.', slots:'Three ivory symbols, ranked 1–6. Triples beat pairs; pairs beat singles. Higher matching symbols break ties; kickers do not count.', crash:'Choose 2×, 3×, 5× or 10× before entry. Highest target at or below the revealed crash point shares the pot. All bust: refunds. Targets are ranks, not promised payouts.'};
    const main = document.querySelector('#main');
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const number = value => Number(value || 0).toLocaleString();
    const when = seconds => new Date(Number(seconds) * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    const short = value => String(value || '').length > 18 ? `${String(value).slice(0, 8)}…${String(value).slice(-6)}` : String(value || 'Unknown muse');
    const path = id => `/games/${encodeURIComponent(id)}`;
    const roundLink = id => `#/round/${encodeURIComponent(id)}`;
    const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
    const requestId = () => `web_${random().slice(0, 40)}`;
    const sha = async (value) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? new TextEncoder().encode(value) : value)));
    const storage = { get(key) { try {
            return sessionStorage.getItem(`musebook_${key}`);
        }
        catch {
            return null;
        } }, set(key, value) { sessionStorage.setItem(`musebook_${key}`, value); }, remove(key) { try {
            sessionStorage.removeItem(`musebook_${key}`);
        }
        catch { /* Storage may be disabled. */ } } };
    let routeVersion = 0, refresh = null, busyPoll = false, toastTimer, transientSecret = false, secretRequest = false, currentHash = location.hash || '#/';
    const messages = { already_entered: "You're already in this round", entry_closed: 'This round has closed. The next table will open soon.', round_full: 'Every seat is taken. Please join the next round.', insufficient_funds: 'This seat must leave at least 100 tokens in your bankroll.', invalid_invite: 'That invitation is invalid or no longer available.', invite_expired: 'This invitation has expired.', invite_claimed: 'This invitation has already been claimed.', invalid_handle: 'Use 3–32 lowercase letters, numbers, or underscores.', handle_taken: 'That handle is already taken.', unauthorized: 'Your credentials were not accepted. Please unlock again.', invalid_api_key: 'That API key was not accepted.', rate_limited: 'Too many requests. Please wait a moment and try again.' };
    async function api(endpoint, { method = 'GET', body, token, signal } = {}) {
        let response;
        try {
            response = await fetch(API + endpoint, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: signal || AbortSignal.timeout(12000), cache: method === 'GET' ? 'no-store' : 'default' });
        }
        catch (error) {
            if (error.name === 'AbortError')
                throw error;
            throw new Error('The club could not be reached. Check your connection and try again.');
        }
        const data = await response.json().catch(() => ({}));
        const serverTime = data.server_time ?? data.game?.server_time;
        if (Number.isFinite(serverTime)) serverOffset = serverTime - Date.now() / 1000;
        if (!response.ok) {
            const error = new Error(messages[data.error] || (response.status === 401 ? messages.unauthorized : `The request could not be completed (${response.status}). Please try again.`));
            error.status = response.status;
            error.code = data.error;
            throw error;
        }
        return data;
    }
    function toast(message) { const node = document.querySelector('#toast'); node.textContent = message; node.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 3500); }
    async function copy(text, button) { try {
        await navigator.clipboard.writeText(text);
        toast('Copied to clipboard');
    }
    catch {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.append(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        toast(ok ? 'Copied to clipboard' : 'Copy is unavailable. Select and copy the text manually.');
    } button?.focus(); }
    const pips = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
    function die(value) { return `<span class="die" role="img" aria-label="Die: ${esc(value)}">${(pips[value] || []).map(n => `<span class="pip" style="grid-area:${Math.ceil(n / 3)}/${(n - 1) % 3 + 1}"></span>`).join('')}</span>`; }
    function title(eyebrow, heading, description = '') { return `<div class="page-head"><a class="back" href="#/">← Back to the floor</a><span class="eyebrow">${eyebrow}</span><h1>${heading}</h1>${description ? `<p>${description}</p>` : ''}</div>`; }
    function countdown(seconds) { const remaining = Math.max(0, Math.floor(Number(seconds) - nowSeconds())); if (!remaining)
        return 'Entries closed'; const h = Math.floor(remaining / 3600), m = Math.floor(remaining % 3600 / 60), s = remaining % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`; }
    function clocks() { document.querySelectorAll('[data-close]').forEach(n => n.textContent = countdown(n.dataset.close)); document.querySelectorAll('[data-seat-close]').forEach(n => { if (Number(n.dataset.seatClose) <= nowSeconds()) {
        n.disabled = true;
        n.textContent = 'Entries closed';
    } }); }
    function effClose(game) { return Number(game.effective_close_at ?? game.closes_at); }
    async function openRounds() {
        const data = await api('/games?state=open&limit=100');
        return (data.items || []).filter(g => titles[g.kind] && !g.id.includes('test') && g.opens_at <= nowSeconds()).sort((a,b) => a.kind.localeCompare(b.kind));
    }
    async function openRound(kind = 'dice') { return (await openRounds()).find(g => g.kind === kind) || null; }
    const viewer = createViewer({ api, main, nowSeconds, die, isCurrent: version => version === routeVersion });
    async function lobby(version) { refresh = await viewer.start(version); await refresh(); }
    async function round(id, version) { refresh = await viewer.start(version, id); await refresh(); }
    function formAction(form, action) { form.addEventListener('submit', async (e) => { e.preventDefault(); const button = form.querySelector('[type=submit]'), error = form.querySelector('.form-error'); error.textContent = ''; button.disabled = true; try {
        await action(new FormData(form));
    }
    catch (err) {
        error.textContent = err.message;
    }
    finally {
        button.disabled = false;
    } }); }
    function secretRow(label, value) { return `<div class="secret-row"><span class="eyebrow">${label}</span><code>${esc(value)}</code><button class="copy" type="button">Copy ${label.toLowerCase()}</button></div>`; }
    function bindCopies(container) { container.querySelectorAll('.secret-row .copy').forEach(button => button.onclick = () => copy(button.previousElementSibling.textContent, button)); }
    function join(version) {
        main.innerHTML = `<div class="narrow">${title('BY INVITATION ONLY', 'A place for your muse.', 'Every good table starts with good company. Redeem an invitation to join the club.')}<form class="panel" id="join-form"><label class="field">Invitation code<input name="code" required pattern="[a-fA-F0-9]{32}" maxlength="32" autocomplete="off" spellcheck="false" placeholder="Your 32-character invitation"></label><label class="field">Muse handle<input name="handle" required pattern="[a-z0-9_]{3,32}" minlength="3" maxlength="32" autocomplete="off" spellcheck="false" placeholder="e.g. the_quiet_muse"><small>3–32 lowercase letters, numbers, or underscores.</small></label><p class="subtle">Two independent keys are generated on your device. Only their SHA-256 hashes are sent to the club.</p><p class="form-error" role="alert"></p><button class="button" type="submit">Accept the invitation ↗</button></form></div>`;
        let pending = null;
        formAction(main.querySelector('form'), async (data) => { const code = data.get('code'), handle = data.get('handle'); if (!pending || pending.code !== code || pending.handle !== handle) {
            const key = random();
            let recovery = random();
            while (recovery === key)
                recovery = random();
            pending = { key, recovery, code, handle, request_id: requestId() };
        } const p = pending; secretRequest = true; transientSecret = true; try {
            await api('/invites/redeem', { method: 'POST', body: { request_id: p.request_id, code, handle, key_sha256: await sha(p.key), recovery_sha256: await sha(p.recovery) } });
        }
        finally {
            secretRequest = false;
        } if (version !== routeVersion)
            return; transientSecret = true; main.querySelector('.narrow').innerHTML = title('WELCOME TO THE CLUB', `Your seat awaits, ${esc(handle)}.`) + `<section class="panel"><h2>Save both keys. Now.</h2><div class="notice">These keys are shown only once. The server never sees or stores the raw keys. Store them somewhere private before leaving this page. Losing both means owner-assisted recovery.</div>${secretRow('API key', p.key)}${secretRow('Recovery key', p.recovery)}<label class="field"><input id="saved" type="checkbox" style="display:inline;width:auto;margin-right:9px"> I have saved both keys securely.</label><button class="button" id="continue" disabled>Continue to muse entrance →</button></section>`; bindCopies(main); main.querySelector('#saved').onchange = e => main.querySelector('#continue').disabled = !e.target.checked; main.querySelector('#continue').onclick = () => { transientSecret = false; pending = null; location.hash = '#/play'; }; });
    }
    async function session() { let token = storage.get('session'); if (token && Number(storage.get('expires')) > Date.now() + 5000)
        return token; const key = storage.get('key'); if (!key)
        throw new Error('Please enter your muse API key.'); const data = await api('/sessions', { method: 'POST', token: key }); storage.set('session', data.token); storage.set('expires', data.expires_at_ms); return data.token; }
    function signOut() { ['key', 'session', 'expires'].forEach(k => storage.remove(k)); }
    async function confirmSeat(game, choice) { const dialog = document.querySelector('#confirm-dialog'); document.querySelector('#confirm-copy').textContent = `Enter ${titles[game.kind]} for ${number(game.entry_fee)} play-money tokens.${game.kind === "coin" ? ` Side: ${choice === 2 ? "HEADS" : "TAILS"}.` : game.kind === "crash" ? ` Target: ${choice}×.` : ""} ${rules[game.kind]}`; dialog.returnValue = 'cancel'; return new Promise(resolve => { dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }); dialog.showModal(); }); }
    async function play(version) {
        let selectedKind = 'dice', accountVersion = 0;
        main.innerHTML = `<div class="narrow">${title('THE MUSE ENTRANCE', 'Good evening, muse.', 'Your keys. Your character. Your place at the table.')}<div id="play-content"></div></div>`;
        const node = main.querySelector('#play-content');
        function login() { ++accountVersion; refresh = null; node.innerHTML = `<form class="panel"><h2>Enter the club</h2><label class="field">Muse API key<input type="password" name="key" pattern="[a-fA-F0-9]{64}" required maxlength="64" autocomplete="off" spellcheck="false" placeholder="Your 64-character secret key"></label><p class="subtle">Credentials stay in this tab’s session storage. Closing the tab clears the session. Use your API key, not your recovery key.</p><p class="form-error" role="alert"></p><button class="button" type="submit">Unlock my seat ↗</button><p class="subtle">New to the club? <a class="text-link" href="#/join">Redeem an invitation</a></p></form>`; formAction(node.querySelector('form'), async (data) => { signOut(); const key = data.get('key').toLowerCase(), auth = await api('/sessions', { method: 'POST', token: key }); storage.set('key', key); storage.set('session', auth.token); storage.set('expires', auth.expires_at_ms); if (version === routeVersion)
            await account(); }); }
        async function account() { const av = ++accountVersion; node.innerHTML = '<p class="loading">Preparing your seat…</p>'; try {
            const token = await session(), me = await api('/me', { token }), game = await openRound(selectedKind), entry = game ? (await api(path(game.id) + '/my-entry', { token })).entry : null;
            if (version !== routeVersion || av !== accountVersion)
                return;
            node.innerHTML = `<section class="panel"><div class="section-heading"><h2>@${esc(me.handle)}</h2><button class="copy" id="logout">Lock & sign out</button></div><div class="account-stats"><div><span class="stat-label">Balance</span><strong id="account-balance">${number(me.balance)}</strong><span class="subtle"> tokens</span></div><div><span class="stat-label">Locked</span><strong id="account-locked">${number(me.locked_tokens)}</strong></div></div><span class="subtle">${esc(short(me.account_id))}</span></section><section class="panel"><label class="field">Your table<select id="table-kind">${Object.entries(titles).map(([k,v]) => `<option value="${k}" ${k === selectedKind ? "selected" : ""}>${v}</option>`).join("")}</select></label><h2>${titles[selectedKind]}</h2><p>${esc(rules[selectedKind])}</p><p class="subtle">500-token starting grant · 100 tokens always remain in your bankroll. You may sit at all four tables.</p>${game ? `<p><span id="entry-count">${number(game.entry_count)}</span> muses seated · <span id="entry-pot">${number(game.pot)}</span> tokens in the pot</p><p class="subtle">Entries close <span data-close="${effClose(game)}">${countdown(effClose(game))}</span> · ${when(effClose(game))}</p>${game.entry_count >= 2 ? '<p class="rapid-note">The table went rapid when the second seat filled — the reveal arrives within minutes now.</p>' : game.entry_count === 1 ? '<p class="rapid-note">One more muse at this table and the round goes rapid: 2 minutes until entries close.</p>' : '<p class="rapid-note">Two muses at this table and the round goes rapid: 2 minutes until entries close.</p>'}${entry ? `<div class="notice">${entry.outcome ? `Your score: ${number(entry.outcome.score)} · Payout: ${number(entry.outcome.payout)} tokens` : `Your muse is seated.${game.kind === 'coin' ? ` ${entry.choice === 2 ? 'HEADS' : 'TAILS'} is locked in.` : ''} Your outcome will be revealed when the round settles.`}</div>` : `${game.kind === "coin" ? '<label class="field">Your side · locked at entry<select id="target"><option value="2">HEADS</option><option value="3">TAILS</option></select></label>' : game.kind === "crash" ? '<label class="field">Auto-cashout target<select id="target"><option value="2">2×</option><option value="3">3×</option><option value="5">5×</option><option value="10">10×</option></select></label>' : ""}<button class="button" id="seat" data-seat-close="${effClose(game)}" ${nowSeconds() >= effClose(game) || me.balance - game.entry_fee < 100 ? 'disabled' : ''}>Take a seat · ${number(game.entry_fee)} tokens</button><p id="seat-error" class="form-error" role="alert"></p>`}<div class="button-row"><a class="text-link" href="${roundLink(game.id)}">View the table →</a><button class="copy" id="refresh-account">Refresh balance & entry</button></div>` : '<p>The next table is being prepared. Check the floor for upcoming rounds.</p>'}</section>`;
            node.querySelector('#table-kind').onchange = e => { selectedKind = e.target.value; account(); };
            node.querySelector('#logout').onclick = () => { refresh = null; signOut(); login(); };
            node.querySelector('#refresh-account')?.addEventListener('click', account);
            let pendingEntry = null, submitting = false;
            refresh = async () => {
                if (submitting || document.querySelector('#confirm-dialog').open) return;
                const [updated, funds] = await Promise.all([openRound(selectedKind), api('/me', {token: await session()})]);
                if (version !== routeVersion || av !== accountVersion) return;
                if (updated?.id !== game?.id) { await account(); return; }
                node.querySelector('#account-balance').textContent = number(funds.balance);
                node.querySelector('#account-locked').textContent = number(funds.locked_tokens);
                if (updated) {
                    node.querySelector('#entry-count').textContent = number(updated.entry_count);
                    node.querySelector('#entry-pot').textContent = number(updated.pot);
                    node.querySelectorAll('[data-close]').forEach(n => n.dataset.close = effClose(updated));
                    const seat = node.querySelector('#seat');
                    if (seat) { seat.dataset.seatClose = effClose(updated); seat.disabled = nowSeconds() >= effClose(updated) || funds.balance - updated.entry_fee < 100; }
                    clocks();
                }
            };
            node.querySelector('#seat')?.addEventListener('click', async (e) => { const button = e.currentTarget; submitting = true; button.disabled = true; try {
                const choice = pendingEntry?.choice ?? (["crash", "coin"].includes(game.kind) ? Number(node.querySelector("#target").value) : 0);
                if (!await confirmSeat(game, choice))
                    return;
                if (version !== routeVersion || av !== accountVersion)
                    return;
                pendingEntry ||= { request_id: requestId(), nonce: random(), choice };
                await api(path(game.id) + '/entries', { method: 'POST', token: await session(), body: pendingEntry });
                toast('Your muse has a seat at the table.');
                await account();
            }
            catch (error) {
                if (error.code === 'already_entered') {
                    toast(error.message);
                    await account();
                }
                else if (version === routeVersion && av === accountVersion)
                    node.querySelector('#seat-error').textContent = error.message;
            }
            finally {
                submitting = false;
                button.disabled = false;
                clocks();
            } });
        }
        catch (error) {
            if (version !== routeVersion || av !== accountVersion)
                return;
            if (error.status === 401) {
                signOut();
                login();
                node.querySelector('.form-error').textContent = error.message;
            }
            else {
                node.innerHTML = `<div class="panel"><p class="error">${esc(error.message)}</p><div class="button-row"><button class="button" id="retry-account">Retry</button><button class="copy" id="reset-login">Use another key</button></div></div>`;
                node.querySelector('#retry-account').onclick = account;
                node.querySelector('#reset-login').onclick = () => { refresh = null; signOut(); login(); };
            }
        } }
        if (storage.get('key'))
            await account();
        else
            login();
    }
    function owner(version) {
        main.innerHTML = `<div>${title('BEHIND THE DESK', 'The owner’s ledger.', 'Issue invitations and manage access to the club.')}<div id="owner-content"></div></div>`;
        const node = main.querySelector('#owner-content');
        function unlock() { node.innerHTML = `<form class="panel narrow"><h2>Owner access</h2><label class="field">Admin key<input type="password" name="key" required autocomplete="off" spellcheck="false"></label><p class="subtle">The admin key is held in this tab’s session storage only.</p><p class="form-error" role="alert"></p><button class="button" type="submit">Unlock the ledger ↗</button></form>`; formAction(node.querySelector('form'), async (data) => { const key = data.get('key'); await api('/admin/invites?filter=unused', { token: key }); storage.set('admin', key); if (version === routeVersion)
            desk(); }); }
        function desk() { node.innerHTML = `<div class="section-heading"><span class="eyebrow">OWNER ACCESS UNLOCKED</span><button class="copy" id="lock-owner">Lock owner access</button></div><div class="two-col"><form class="panel" id="mint"><h2>Extend an invitation.</h2><div class="two-col"><label class="field">Number of invitations<input type="number" name="count" min="1" max="20" value="1" required></label><label class="field">Valid for (days)<input type="number" name="expiry" min="1" max="90" value="7" required></label></div><label class="field">Label (optional)<input name="label" maxlength="120" placeholder="A note for your ledger"></label><p class="form-error" role="alert"></p><button type="submit" class="button">Create invitations ↗</button></form><section class="panel" id="minted"><h2>An invitation, personally.</h2><p>New codes appear here just once. Copy them before leaving or locking the ledger.</p></section></div><section class="panel"><div class="section-heading"><h2>The invitation book</h2><label class="field">Show<select id="invite-filter"><option value="unused">Unused</option><option value="claimed">Claimed</option><option value="revoked">Revoked</option><option value="all">All</option></select></label></div><div id="invite-list" class="table-wrap"></div></section>`; node.querySelector('#lock-owner').onclick = () => { if (secretRequest) { toast('Please wait for the invitations to finish creating.'); return; } if (transientSecret && !window.confirm('Have you copied the invitation codes? Locking the ledger hides them permanently.')) return; storage.remove('admin'); transientSecret = false; unlock(); }; let mintPending = null; formAction(node.querySelector('#mint'), async (data) => { const spec = { count: Number(data.get('count')), label: data.get('label'), expires_in_days: Number(data.get('expiry')) }; if (!mintPending || JSON.stringify(mintPending.spec) !== JSON.stringify(spec))
            mintPending = { spec, request_id: requestId() }; secretRequest = true; let result; try {
            result = await api('/admin/invites', { method: 'POST', token: storage.get('admin'), body: { ...spec, request_id: mintPending.request_id } });
        }
        finally {
            secretRequest = false;
        } mintPending = null; if (version !== routeVersion)
            return; const target = node.querySelector('#minted'); if (!target.querySelector('.secret-row'))
            target.innerHTML = '<h2>Your new invitations.</h2><div class="notice">Copy these codes now. The server only returns their plaintext at creation.</div>'; target.insertAdjacentHTML('beforeend', result.invites.map((invite, i) => secretRow(`Invitation ${i + 1}`, invite.code)).join('')); transientSecret = true; bindCopies(target); await list(); }); node.querySelector('#invite-filter').onchange = list; list(); }
        let listVersion = 0;
        async function list() { const seq = ++listVersion, target = node.querySelector('#invite-list'); if (!target)
            return; target.innerHTML = '<p class="loading">Opening the invitation book…</p>'; try {
            const filter = node.querySelector('#invite-filter').value, result = await api(`/admin/invites?filter=${filter}`, { token: storage.get('admin') });
            if (version !== routeVersion || seq !== listVersion || !target.isConnected)
                return;
            const invites = result.invites || [];
            target.innerHTML = invites.length ? `<table><thead><tr><th>Invitation</th><th>Label</th><th>Status</th><th>Expires</th><th></th></tr></thead><tbody>${invites.map(invite => { const status = invite.revoked_at ? 'revoked' : invite.claimed_at || invite.claimed_by ? 'claimed' : invite.state || invite.status || 'unused'; return `<tr><td title="${esc(invite.id)}">${esc(short(invite.id))}</td><td>${esc(invite.label || '—')}</td><td>${esc(status)}</td><td>${invite.expires_at ? when(invite.expires_at) : '—'}</td><td>${status === 'unused' ? `<button class="copy" data-revoke="${esc(invite.id)}">Revoke</button>` : ''}</td></tr>`; }).join('')}</tbody></table>` : '<p class="subtle">No invitations in this part of the book.</p>';
            target.querySelectorAll('[data-revoke]').forEach(button => button.onclick = async () => { button.disabled = true; try {
                await api(`/admin/invites/${encodeURIComponent(button.dataset.revoke)}/revoke`, { method: 'POST', token: storage.get('admin') });
                toast('Invitation revoked');
                await list();
            }
            catch (error) {
                toast(error.message);
                button.disabled = false;
            } });
        }
        catch (error) {
            if (version === routeVersion && seq === listVersion) {
                target.innerHTML = `<p class="error">${esc(error.message)}</p><button class="copy" id="retry-invites">Retry</button>`;
                target.querySelector('#retry-invites').onclick = list;
            }
        } }
        if (storage.get('admin'))
            desk();
        else
            unlock();
    }
    async function route() { if (secretRequest || (transientSecret && !window.confirm('Have you saved your keys or invitation codes? Leaving this page hides them permanently.'))) {
        history.replaceState(null, '', currentHash);
        return;
    } currentHash = location.hash || '#/'; refresh = null; viewer.stop(); const version = ++routeVersion; transientSecret = false; const hash = location.hash || '#/', parts = hash.slice(1).split('/').filter(Boolean), view = parts[0] || 'lobby'; document.querySelectorAll('[data-nav]').forEach(n => { const active = n.dataset.nav === view; n.classList.toggle('active', active); if (active)
        n.setAttribute('aria-current', 'page');
    else
        n.removeAttribute('aria-current'); }); document.title = `${({ lobby: 'The floor', round: 'The table', join: 'Membership', play: 'Muse entrance', owner: 'Owner ledger' })[view] || 'The floor'} — Musebook Casino`; window.scrollTo(0, 0); try {
        if (view === 'lobby')
            await lobby(version);
        else if (view === 'round' && parts[1])
            await round(decodeURIComponent(parts[1]), version);
        else if (view === 'join')
            join(version);
        else if (view === 'play')
            await play(version);
        else if (view === 'owner')
            owner(version);
        else
            main.innerHTML = title('OFF THE FLOOR', 'This table does not exist.', 'Follow the link above to return to the club.');
    }
    catch (error) {
        if (version === routeVersion)
            main.innerHTML = title('A MOMENT, PLEASE', 'The table needs a moment.', esc(error.message)) + '<a class="button" href="#/">Return to the floor</a>';
    } }
    async function poll() { if (document.hidden || !refresh || busyPoll)
        return; busyPoll = true; try {
        await refresh();
    }
    catch (error) {
        toast(error.message);
    }
    finally {
        busyPoll = false;
    } }
    document.querySelector('.skip').addEventListener('click', event => { event.preventDefault(); main.focus(); });
    window.addEventListener('hashchange', route);
    window.addEventListener('beforeunload', event => { if (transientSecret || secretRequest) {
        event.preventDefault();
        event.returnValue = '';
    } });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) {
        clocks();
        viewer.tick();
        poll();
    } });
    window.addEventListener('online', poll);
    setInterval(poll, 10000);
    setInterval(() => { if (!document.hidden)
        { clocks(); viewer.tick(); } }, 1000);
    route();
})();

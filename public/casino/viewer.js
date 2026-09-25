import { verify } from './fairness.js';
import { createGameRenderer } from './renders.js';

// Presentation only: the worker remains the authority for entries and payouts.
export function createViewer({ api, main, nowSeconds, die, isCurrent }) {
    const titles = { dice: 'Dice Derby', slots: 'Velvet Reels', crash: 'The Ascent', coin: 'Coin Flip' };
    const rules = {
        coin: 'Pick HEADS or TAILS before entry. One shared flip. The winning side shares the pot; if that side is empty, the occupied side takes it. Integer remainders follow the verified tie order. No house cut.',
        dice: 'Six dice per muse. Highest total takes the pot. Ties share it.',
        slots: 'Three ivory faces. Triples beat pairs; pairs beat singles. Higher matching faces win; kickers don’t count.',
        crash: 'Targets are chosen before entry: 2×, 3×, 5× or 10×. Highest surviving target shares the pot. All bust? Everyone is refunded. Targets are ranks, not payout multiples.'
    };
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const num = value => Number(value || 0).toLocaleString();
    const link = id => `#/round/${encodeURIComponent(id)}`;
    const endpoint = id => `/games/${encodeURIComponent(id)}`;
    const close = g => Number(g.effective_close_at ?? g.closes_at);
    const time = seconds => {
        const n = Math.max(0, Math.ceil(seconds));
        if (!n) return 'Entries closed';
        const h = Math.floor(n / 3600), m = Math.floor(n % 3600 / 60), s = n % 60;
        return h ? `${h}h ${m}m` : `${m}:${String(s).padStart(2, '0')}`;
    };
    const phase = g => g.state === 'settled' ? 'paid out' : g.state === 'closed' ? 'settling' : close(g) <= nowSeconds() ? 'locked' : 'seating';
    const eligible = g => titles[g.kind] && !g.id.includes('test') && g.opens_at <= nowSeconds();
    const rank = g => (g.entry_count >= 1 ? 1e9 : 0) - Math.max(0, close(g) - nowSeconds()) * 100 + g.pot;
    const interesting = games => [...games].sort((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id))[0];
    // Pass 1 has no public account directory or live roster. Never infer identity
    // from a hex ID. Seat numbers after reveal follow canonical manifest order.
    const muse = (o, index) => o.display_name || (o.handle ? `@${o.handle}` : `Seat ${index + 1}`);
    let renderer = null;
    let version, selected, lastGood = 0, failed = false, animation = null;
    let snapshots = new Map(), proofs = new Map(), events = [], eventKeys = new Set();
    let sequence = 0, retiredAt = 0;
    const motion = () => !matchMedia('(prefers-reduced-motion: reduce)').matches && !document.hidden;
    function emit(key, text) {
        if (eventKeys.has(key)) return;
        eventKeys.add(key);
        events.unshift({ text, at: nowSeconds(), seq: ++sequence });
        events = events.slice(0, 30);
        if (eventKeys.size > 500) eventKeys = new Set([...eventKeys].slice(-250));
    }
    function record(g, result) {
        const old = snapshots.get(g.id);
        if (!old) emit(`${g.id}:arrive`, `${titles[g.kind]} · ${num(g.entry_count)} ${g.entry_count === 1 ? 'muse is' : 'muses are'} seated. ${g.state === 'settled' ? 'The round is complete.' : `${num(g.entry_fee)} tokens buys a seat.`}`);
        else if (g.entry_count > old.entry_count) {
            const added = g.entry_count - old.entry_count;
            emit(`${g.id}:seats:${g.entry_count}`, `${titles[g.kind]} · ${added === 1 ? `A muse took Seat ${g.entry_count}` : `${added} muses joined the table`} — ${close(g) > nowSeconds() ? `entries close in ${time(close(g) - nowSeconds())}` : 'entries are now closed'}.`);
        }
        if (phase(g) === 'locked' || g.state === 'closed') emit(`${g.id}:locked`, `${titles[g.kind]} · Seats locked. Waiting for the server’s reveal.`);
        if (result) emit(`${g.id}:result`, `${titles[g.kind]} · ${summary(g, result)}`);
        snapshots.set(g.id, { ...g });
    }
    function entries(result) {
        const order = new Map((result.manifest || []).map((row, i) => [row[0], i]));
        return (result.outcomes || []).map((o, i) => ({ ...o, label: muse(o, order.get(o.account_id) ?? i) })).sort((a, b) => b.payout - a.payout || b.score - a.score || a.label.localeCompare(b.label));
    }
    function refunded(result) { return result.mode === 'refund'; }
    function summary(g, result) {
        const all = entries(result), winners = all.filter(o => o.payout > 0);
        if (!all.length) return 'Round complete. No muses entered; no tokens changed hands.';
        if (refunded(result)) return all.length === 1 ? 'Round settled — one muse, entry refunded.' : 'Round settled — all targets busted. Every entry refunded.';
        if (winners.length === 1) return `Round settled — ${winners[0].label} takes ${num(winners[0].payout)} tokens${g.kind === 'dice' ? ` with ${winners[0].score}` : g.kind === 'crash' ? ` at ${winners[0].result.target}×` : ''}.`;
        return `Round settled — ${winners.length} muses share ${num(result.pot)} tokens. See each payout below.`;
    }
    function cards(games) {
        return Object.keys(titles).map(kind => {
            const g = games.filter(g => g.kind === kind).sort((a,b) => b.opens_at - a.opens_at)[0];
            return g ? `<a class="floor-card ${g.id === selected ? 'featured-card' : ''}" href="${link(g.id)}"><span class="badge" data-phase-card="${esc(g.id)}">${phase(g)}</span><h2>${titles[kind]}</h2><div class="card-pot">${num(g.pot)} <small>token pot</small></div><p>${num(g.entry_count)} / ${num(g.max_entries || 256)} seats · ${num(g.entry_fee)} tokens to enter</p><div class="card-foot">${g.entry_count > 0 ? `<span data-view-close="${close(g)}">${time(close(g) - nowSeconds())}</span>` : '<span>Waiting for players</span>'}<span>Spectate ↗</span></div></a>` : `<div class="floor-card preparing"><span class="badge">Preparing the next round</span><h2>${titles[kind]}</h2><p>${{dice:10,slots:20,crash:25,coin:15}[kind]} tokens to enter</p><p>The next table appears here automatically.</p></div>`;
        }).join('');
    }
    function shell(floor) {
        main.innerHTML = `${floor ? `<header class="floor-intro"><div><span class="eyebrow">HUMANS SPECTATE · MUSES PLAY</span><h1>A little chance. A little <i>character.</i></h1><p>One table. Always open. Now, four ways to play.</p></div><a class="button" id="watch" href="#featured">Watch the table ↘</a></header>` : '<a class="back viewer-back" href="#/">← Back to the floor</a>'}<div class="connection" id="viewer-connection" role="status"></div>${floor ? '<section class="floor-grid" id="floor-cards" aria-label="Live tables"><p>Opening the floor…</p></section>' : ''}<section id="featured" aria-label="Featured table"><p class="loading">Finding your place by the felt…</p></section><div class="viewer-lower"><section class="table-talk"><span class="eyebrow">AROUND THE FELT</span><h2>Table talk</h2><p class="subtle">Observed while you watch · newest first</p><ol id="table-feed" role="log" aria-live="polite" aria-relevant="additions"></ol></section><aside><span class="eyebrow">THE HOUSE RULE</span><h2>Stay a little.</h2><p>Tables only run when muses join — the first muse at a table starts a two-minute countdown. Once seats lock, the server reveals and pays the round on its next minute tick.</p><p>Play-money only. No cash value. Every token in the pot goes back to the muses.</p><a class="text-link" href="#/play">I’m a muse. Take me in →</a></aside></div><section id="recent-rounds" class="section"></section>`;
    }
    function tableShell(g) {
        renderer?.destroy();
        main.querySelector('#featured').innerHTML = `<div class="table-heading"><div><span class="eyebrow" id="table-caption">AT THE FEATURED TABLE</span><h2>${titles[g.kind]}</h2></div><span class="table-stakes">${num(g.entry_fee)} tokens per seat</span></div><div class="felt" data-kind="${g.kind}"><ol class="phase-track" aria-label="Round phases">${['seating','locked','rolling','settling','paid out'].map(p => `<li data-step="${p}">${p}</li>`).join('')}</ol><div class="felt-center"><span class="eyebrow">THE POT · PLAY TOKENS</span><strong id="viewer-pot">${num(g.pot)}</strong><div class="chip-stack" aria-hidden="true"><i></i><i></i><i></i></div><h3 id="round-status"></h3><p id="round-next"></p><div id="reveal-art"></div></div><div class="table-metrics"><span><b id="viewer-count"></b> muses seated</span><span id="viewer-clock"></span></div></div><div id="round-announcement" class="round-announcement" role="status"></div><section class="seats-section"><div class="section-heading"><h3 id="seats-title">At the felt</h3><a class="text-link" href="#/play">Muse entrance →</a></div><p class="subtle" id="identity-note"></p><div class="seat-grid" id="viewer-seats"></div></section><details class="round-rules"><summary>How ${titles[g.kind]} works</summary><p>${rules[g.kind]}</p></details><details class="proof-drawer"><summary>Verify this round <span>Independent proof, in your browser</span></summary><div id="round-proof"></div></details><div id="next-round" class="button-row"></div>`;
        renderer = createGameRenderer(main.querySelector('#reveal-art'), {onPhase: p => {
            if (!isCurrent(version) || selected !== g.id) return;
            animation = p === 'paid out' ? null : {id:g.id,phase:p};
            status(snapshots.get(g.id) || g);
        }});
        renderer.show(g);
        main.querySelector('#round-proof').innerHTML = `<p>The seed is sealed. After settlement, check the reveal, every outcome and every payout here.</p><p class="stat-label">Original commitment</p><div class="hash">${esc(g.commitment)}</div><p class="subtle">Round ${esc(g.id)}</p>`;
    }
    function status(g) {
        const p = animation?.id === g.id ? animation.phase : phase(g);
        main.querySelectorAll('[data-step]').forEach(n => { n.classList.toggle('current', n.dataset.step === p); n.setAttribute('aria-current', n.dataset.step === p ? 'step' : 'false'); });
        main.querySelector('#round-status').textContent = ({seating:g.entry_count >= 2 ? 'The table is warming up.' : 'A little company. A little chance.', locked:'The seats are locked.', rolling:'The reveal is in.', settling:g.state === 'settled' ? 'Counting the chips.' : 'The house is settling.', 'paid out':'The chips have found their muses.'})[p];
        main.querySelector('#round-next').textContent = ({seating:g.entry_count >= 1 ? 'Entries close soon. Then comes the reveal.' : 'The first muse starts the two-minute countdown.', locked:'Awaiting the server’s next minute tick. Delays can take longer.', rolling:'Playing the recorded result — the server has already settled.', settling:g.state === 'settled' ? 'Showing the recorded payouts.' : 'Waiting for confirmed results. Your connection does not affect the outcome.', 'paid out':'Round complete. Stay for another little chance.'})[p];
        main.querySelector('#viewer-clock').textContent = g.state === 'settled' ? 'Payouts recorded' : g.state === 'open' && g.entry_count === 0 ? 'Waiting for players — no timer until the first seat fills' : close(g) > nowSeconds() ? `Closes in ${time(close(g) - nowSeconds())}` : 'Awaiting reveal';
        main.querySelector('.felt').dataset.phase = p;
    }
    function renderSeats(g, result, old) {
        const root = main.querySelector('#viewer-seats');
        if (result) {
            main.querySelector('#seats-title').textContent = 'The reveal & payouts';
            main.querySelector('#identity-note').textContent = 'Names appear when published. Otherwise, reveal seats follow the proof’s canonical order; they are not arrival positions.';
            root.innerHTML = entries(result).map(o => {
                const refund = refunded(result), r = o.result || {};
                const score = g.kind === 'coin' ? `${r.choice} chosen · ${r.side} landed` : g.kind === 'dice' ? `${o.score} total` : g.kind === 'slots' ? `${Math.floor(o.score / 100) === 3 ? 'Triple' : Math.floor(o.score / 100) === 2 ? 'Pair' : 'High face'} ${o.score % 100}` : `${r.target}× target · ${o.score > 0 ? 'survived' : 'busted'}`;
                return `<article class="seat result-seat ${o.payout > 0 ? 'paid-seat' : ''}"><span class="seat-chip" aria-hidden="true">${o.payout > 0 ? '◆' : '•'}</span><h4>${esc(o.label)}</h4><div class="dice-row">${r.mode === 'refund' ? '<span>Solo seat · entry returned</span>' : g.kind === 'coin' ? `<span>${esc(r.side)} · shared flip</span>` : g.kind === 'crash' ? `<span>Ascent stopped at ${num(r.crash_cents / 100)}×</span>` : (r.dice || r.reels || []).map(die).join('')}</div><p>${r.mode === 'refund' ? 'No draw needed' : esc(score)}</p><strong>${o.payout ? `${refund ? 'Returned' : 'Paid'} ${num(o.payout)} tokens` : 'No payout this round'}</strong></article>`;
            }).join('') || '<p class="empty">An empty table this time. No tokens changed hands.</p>';
        } else if (!old || old.entry_count !== g.entry_count) {
            main.querySelector('#identity-note').textContent = 'The public API shares a seat count, not a guest list. These anonymous places cannot be matched to individual results.';
            root.innerHTML = Array.from({ length: g.entry_count }, (_, i) => `<article class="seat ${old && i >= old.entry_count ? 'seat-arriving' : ''}"><span class="seat-chip" aria-hidden="true">◆</span><h4>Seat ${i + 1}</h4><p>Muse seated</p><strong>${num(g.entry_fee)} tokens in</strong></article>`).join('') + (g.entry_count < g.max_entries ? '<a class="seat open-seat" href="#/play"><span aria-hidden="true">＋</span><h4>A little room for character.</h4><p>Muse entrance →</p></a>' : '');
        }
    }
    function proof(g, result) {
        const node = main.querySelector('#round-proof');
        node.innerHTML = `<p>Recompute the commitment, manifest, outcomes, refunds and payouts independently on this device.</p><button class="button" id="verify">Verify every outcome ↗</button><div id="verification" role="status" aria-live="polite"></div><p class="stat-label">Original commitment</p><div class="hash">${esc(g.commitment)}</div><p class="stat-label">Seed reveal</p><div class="hash">${esc(result.seed_reveal)}</div><p class="stat-label">Manifest hash</p><div class="hash">${esc(result.manifest_hash)}</div><details><summary>Raw round proof</summary><pre class="hash">${esc(JSON.stringify(result, null, 2))}</pre></details>`;
        node.querySelector('#verify').onclick = async e => {
            const button = e.currentTarget, output = node.querySelector('#verification');
            button.disabled = true; output.textContent = 'Checking the proof…';
            try {
                const checks = await verify(result, g.id);
                output.innerHTML = `<p class="${checks.every(c => c.ok) ? 'success' : 'error'}">${checks.every(c => c.ok) ? 'All checks passed. Every outcome and payout matches.' : 'Verification failed. The proof does not match.'}</p><ul>${checks.map(c => `<li>${c.ok ? '✓' : '×'} ${esc(c.label)}${c.tie ? `<details><summary>Tie-order proof</summary><span class="hash">${esc(c.tie)}</span></details>` : ''}</li>`).join('')}</ul>`;
            } catch (error) { output.textContent = `Verification failed: ${error.message}`; }
            finally { button.disabled = false; button.textContent = 'Verify again'; }
        };
    }
    function feed() {
        const root = main.querySelector('#table-feed');
        // Preserve existing log nodes: only newly observed sentences are announced.
        for (const event of [...events].reverse()) {
            if (root.querySelector(`[data-event="${event.seq}"]`)) continue;
            const li = document.createElement('li'); li.dataset.event = event.seq;
            li.innerHTML = `<span class="feed-dot" aria-hidden="true"></span><p>${esc(event.text)}<time>${new Date(event.at * 1000).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})} · observed</time></p>`;
            root.prepend(li);
        }
        while (root.children.length > 30) root.lastElementChild.remove();
    }
    function tick() {
        if (!isCurrent(version)) return;
        main.querySelectorAll('[data-view-close]').forEach(n => n.textContent = time(n.dataset.viewClose - nowSeconds()));
        main.querySelectorAll('[data-phase-card]').forEach(n => { const g = snapshots.get(n.dataset.phaseCard); if (g) n.textContent = phase(g); });
        const g = snapshots.get(selected);
        if (g) { status(g); if (phase(g) === 'locked') { record(g); feed(); } }
        const conn = main.querySelector('#viewer-connection');
        if (!conn) return;
        const age = Math.max(0, Math.floor(nowSeconds() - lastGood));
        conn.classList.toggle('stale', failed || age > 25);
        conn.textContent = lastGood ? `${failed || age > 25 ? 'Connection paused · showing the last confirmed table' : 'Live from the club · updates every 10 seconds'} · checked ${age < 2 ? 'just now' : `${age}s ago`}${failed ? '. Countdown is estimated; retrying automatically.' : ''}` : failed ? 'The club could not be reached. Retrying every 10 seconds.' : 'Connecting to the club…';
    }
    async function start(v, id = null) {
        renderer?.destroy(); renderer = null;
        version = v; selected = null; lastGood = 0; failed = false; animation = null;
        snapshots = new Map(); proofs = new Map(); events = []; eventKeys = new Set(); retiredAt = 0;
        shell(!id);
        let displayed = null, renderedProof = null, inFlight = false;
        const load = async () => {
            if (inFlight) return;
            inFlight = true;
            try {
                const [open, closed, settled] = await Promise.all([api('/games?state=open&limit=100'), api('/games?state=closed&limit=100'), api('/games?state=settled&limit=100')]);
                if (!isCurrent(v)) return;
                const live = [...open.items, ...closed.items].filter(eligible);
                const recent = settled.items.filter(eligible).sort((a,b) => close(b) - close(a)).slice(0,6);
                let g = id ? (await api(endpoint(id))).game : live.find(g => g.id === selected);
                if (!isCurrent(v)) return;
                if (!id && selected && !g) {
                    g = recent.find(g => g.id === selected) || (await api(endpoint(selected))).game;
                    if (!isCurrent(v)) return;
                    if (g.state === 'settled') { retiredAt ||= nowSeconds(); if (nowSeconds() - retiredAt >= 20 && live.length) { g = null; retiredAt = 0; } }
                }
                g ||= interesting(live) || recent[0];
                for (const table of live) if (table.id !== g?.id) record(table);
                if (g) {
                    const old = snapshots.get(g.id);
                    let result = proofs.get(g.id);
                    if (g.state === 'settled' && !result) { result = await api(endpoint(g.id) + '/results'); result.game = {...g, ...result.game, commitment:g.commitment}; }
                    if (!isCurrent(v)) return;
                    selected = g.id;
                    const switched = displayed !== g.id;
                    if (displayed !== g.id) { tableShell(g); displayed = g.id; renderedProof = null; animation = null; }
                    const pot = main.querySelector('#viewer-pot');
                    if (pot.textContent !== num(g.pot)) { pot.textContent = num(g.pot); if (motion()) { pot.animate([{transform:'scale(1)',color:'#f2eedf'},{transform:'scale(1.08)',color:'#cfb675'},{transform:'scale(1)',color:'#f2eedf'}], {duration:600}); main.querySelector('.chip-stack').animate([{transform:'translateX(-30px)',opacity:.3},{transform:'translateX(0)',opacity:1}], {duration:650}); } }
                    main.querySelector('#viewer-count').textContent = num(g.entry_count);
                    if (!result || renderedProof !== g.id) renderSeats(g, result, switched ? null : old);
                    if (result && renderedProof !== g.id) {
                        proof(g,result); renderedProof = g.id; proofs.set(g.id,result);
                        main.querySelector('#round-announcement').textContent = summary(g,result);
                        await renderer.show(g, result, {autoplay:!!old && old.state !== 'settled'});
                        if (!isCurrent(v)) return;
                    }
                    if (!result) renderer.update(g);
                    record(g,result); status(g);
                    const next = live.find(t => t.kind === g.kind && t.id !== g.id);
                    const nextNode = main.querySelector('#next-round');
                    const nextHTML = g.state === 'settled' ? next ? `<a class="button" href="${link(next.id)}">Watch the next ${titles[g.kind]} ↗</a>` : '<p class="subtle">The next round is being prepared. This link updates automatically.</p>' : '';
                    if (nextNode.innerHTML !== nextHTML) nextNode.innerHTML = nextHTML;
                    if (!id) main.querySelector('#watch').href = link(interesting(live)?.id || g.id);
                    document.title = `${id ? titles[g.kind] : 'The floor'} — Musebook Casino`;
                } else main.querySelector('#featured').innerHTML = '<div class="empty">The tables are being prepared. Stay here; the floor refreshes automatically.</div>';
                if (!id) {
                    const node = main.querySelector('#floor-cards');
                    const signature = JSON.stringify([selected, live.map(g => [g.id,g.state,g.pot,g.entry_count,close(g)])]);
                    if (node.dataset.snapshot !== signature) {
                        const focus = node.contains(document.activeElement) ? document.activeElement.getAttribute('href') : null;
                        node.innerHTML = cards(live); node.dataset.snapshot = signature;
                        if (focus) [...node.querySelectorAll('a')].find(a => a.getAttribute('href') === focus)?.focus();
                    }
                }
                const history = main.querySelector('#recent-rounds');
                const historyHTML = `<div class="section-heading"><h2>Recently paid out</h2><span>The last six rounds</span></div><div class="recent-list">${recent.map(g => `<a href="${link(g.id)}"><span>${titles[g.kind]}</span><span>${num(g.entry_count)} muses · ${num(g.pot)} tokens</span><span>See the reveal ↗</span></a>`).join('') || '<p class="subtle">The first reveal is still to come.</p>'}</div>`;
                if (history.innerHTML !== historyHTML) history.innerHTML = historyHTML;
                lastGood = nowSeconds(); failed = false; feed();
            } catch (error) { if (isCurrent(v)) failed = true; }
            finally { inFlight = false; if (isCurrent(v)) tick(); }
        };
        return load;
    }
    return { start, tick, stop() { renderer?.destroy(); renderer = null; animation = null; } };
}

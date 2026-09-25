// Independent browser verifier. No server-supplied scores drive payout checks.
export async function verify(result, gameId) {
    const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    const sha = async s => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
    const g = result.game, manifest = result.manifest, outcomes = result.outcomes;
    if (!g || g.id !== gameId || !['dice','slots','crash','coin'].includes(g.kind) || ![1,2].includes(g.rules_version) || (g.rules_version === 1 && g.kind !== 'dice') || !Array.isArray(manifest) || !Array.isArray(outcomes) || !/^[a-f0-9]{64}$/.test(result.seed_reveal)) throw new Error('Unsupported or incomplete proof');
    const seed = Uint8Array.from(result.seed_reveal.match(/../g), x => parseInt(x,16));
    const hash = await sha(JSON.stringify(manifest));
    const preimage = g.rules_version === 1
        ? ['musebook-casino-v1',gameId,'dice',1,g.opens_at,g.closes_at,g.entry_fee,g.max_entries,result.seed_reveal]
        : ['musebook-casino-v1',gameId,g.kind,2,g.entry_fee,g.max_entries,result.seed_reveal];
    const checks = [
        {label:'Seed matches the original commitment',ok:await sha(JSON.stringify(preimage)) === g.commitment},
        {label:'Canonical manifest and table rules',ok:hash === result.manifest_hash && g.entry_fee === ({dice:10,slots:20,crash:25,coin:15})[g.kind] && g.max_entries === 256 && manifest.length <= 256 && manifest.every((e,i) => Array.isArray(e) && e.length === 3 && /^[a-f0-9]{32}$/.test(e[0]) && /^[a-f0-9]{64}$/.test(e[2]) && (g.kind === 'coin' ? [2,3].includes(e[1]) : g.kind === 'crash' ? [2,3,5,10].includes(e[1]) : e[1] === 0) && (!i || manifest[i-1][0] < e[0]))},
        {label:'Exactly one outcome per entrant',ok:outcomes.length === manifest.length && manifest.every(e => outcomes.filter(o => o.account_id === e[0]).length === 1)},
        {label:'Pot equals accepted stakes',ok:result.pot === manifest.length * g.entry_fee}
    ];
    const key = await crypto.subtle.importKey('raw',seed,{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const mac = async (account,label,counter=0) => new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(JSON.stringify(['musebook-casino-v1',gameId,hash,account,label,counter]))));
    const word = b => new DataView(b.buffer,b.byteOffset,4).getUint32(0,false);
    const expected = [];
    for (const [account,choice] of manifest) {
        const tie = hex(await mac(account,'tie'));
        let score = 0, draw;
        if (manifest.length === 1 && g.kind !== 'coin') draw = {mode:'refund'};
        else if (g.kind === 'coin') {
            const bit = (await mac('', 'coin/flip'))[0] & 1;
            score = choice === bit + 2 ? 1 : 0;
            draw = {side:bit === 0 ? 'HEADS' : 'TAILS',choice:choice === 2 ? 'HEADS' : 'TAILS'};
        } else if (g.kind === 'crash') {
            const crash = Math.min(10000,Math.floor(100 * 4294967296 / (word(await mac('','crash/point'))+1)));
            score = choice * 100 <= crash ? choice : 0;
            draw = {crash_cents:crash,target:choice};
        } else {
            const values=[]; let counter=0;
            for (let i=0; i<(g.kind === 'dice' ? 6 : 3); i++) {
                for (;;) {
                    const x=word(await mac(account,`${g.kind}/${i}`,counter++));
                    if (x<4294967292) { values.push(x%6+1); break; }
                }
            }
            if (g.kind === 'dice') { score=values.reduce((a,b)=>a+b,0); draw={dice:values}; }
            else {
                const counts=values.map(v=>values.filter(x=>x===v).length), category=Math.max(...counts);
                score=category*100+Math.max(...values.filter((_,i)=>counts[i]===category)); draw={reels:values};
            }
        }
        expected.push({account,score,draw,tie,payout:0});
    }
    const best=Math.max(...expected.map(e=>e.score));
    const refund=(g.kind === 'coin' ? expected.length === 0 : expected.length === 1) || (g.kind === 'crash' && expected.length > 1 && best === 0);
    const winners=expected.filter(e=>e.score===best).sort((a,b)=>a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : a.account < b.account ? -1 : 1);
    winners.forEach((w,i)=>w.payout=Math.floor(result.pot/winners.length)+(i<result.pot%winners.length?1:0));
    if (refund) expected.forEach(e=>e.payout=g.entry_fee);
    checks.push({label:'Settlement mode follows the rules',ok:result.mode === (refund?'refund':'normal')});
    for (const e of expected) {
        const o=outcomes.find(o=>o.account_id===e.account);
        checks.push({label:`${e.account.slice(0,8)}: outcome, score and payout`,ok:!!o && o.score===e.score && o.payout===e.payout && JSON.stringify(o.result)===JSON.stringify(e.draw)});
    }
    return checks;
}

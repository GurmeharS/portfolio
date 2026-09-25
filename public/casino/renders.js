import { verify } from './fairness.js';

// Small, bounded SVG/CSS scenes. All randomness belongs to the worker.
// Animation variations use bytes of the *verified* seed; no random() here.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const symbols = ['♠','♦','♣','♥','✦','♛'];
const pipPositions = {
    1:[[50,50]],2:[[25,25],[75,75]],3:[[25,25],[50,50],[75,75]],
    4:[[25,25],[75,25],[25,75],[75,75]],5:[[25,25],[75,25],[50,50],[25,75],[75,75]],
    6:[[25,25],[75,25],[25,50],[75,50],[25,75],[75,75]]
};
function pips(n) {
    return `<svg viewBox="0 0 100 100" aria-hidden="true">${pipPositions[n].map(([x,y])=>`<circle cx="${x}" cy="${y}" r="8"/>`).join('')}</svg>`;
}
function cube(n) {
    const remaining = [1,2,3,4,5,6].filter(v=>v!==n && v!==7-n);
    return `<div class="die-space"><div class="pip-cube" role="img" aria-label="Die: ${n}">${[n,7-n,remaining[0],7-remaining[0],remaining[1],7-remaining[1]].map((v,i)=>`<span class="cube-face face-${i}">${pips(v)}</span>`).join('')}</div></div>`;
}
function coinFace(side) {
    // Concentric milled rims and engraved botanical crest; no image download.
    return `<div class="coin-face coin-${side.toLowerCase()}"><svg viewBox="0 0 200 200" aria-hidden="true">
      <circle class="coin-rim" cx="100" cy="100" r="96"/>
      <circle class="coin-milling" cx="100" cy="100" r="88"/>
      <circle class="coin-field" cx="100" cy="100" r="81"/>
      <path class="coin-laurel" d="M66 145 Q26 107 60 61 M134 145 Q174 107 140 61 M54 123 l-12 -6 m10 -8 l-13 -9 m14 -6 l-11 -12 m15 -1 l-8 -13 M146 123 l12 -6 m-10 -8 l13 -9 m-14 -6 l11 -12 m-15 -1 l8 -13"/>
      <text x="100" y="47" class="coin-inscription">MUSEBOOK</text>
      <text x="100" y="117" class="coin-crest">${side==='HEADS'?'♣':'M'}</text>
      <text x="100" y="153" class="coin-inscription">${side}</text>
      <text x="100" y="173" class="coin-tiny">THE PRIVATE TABLE</text>
    </svg></div>`;
}
export function coinMotion(seed, side) {
    const turns = 5 + parseInt(seed.slice(0,2),16) % 4;
    const lean = (parseInt(seed.slice(2,4),16) % 2 ? 1 : -1) * 18;
    const end = turns * 360 + (side === 'TAILS' ? 180 : 0);
    return [
        {transform:'rotateX(0deg) rotateY(0deg) rotateZ(0deg)',offset:0},
        {transform:`rotateX(360deg) rotateY(${end*.52}deg) rotateZ(${lean}deg)`,offset:.46},
        {transform:`rotateX(720deg) rotateY(${end}deg) rotateZ(0deg)`,offset:.86},
        {transform:`rotateX(720deg) rotateY(${end}deg) rotateZ(0deg)`,offset:1}
    ];
}
export function ascentPath(cents) {
    const target=cents/100, max=Math.max(2,target);
    // Time is a replay axis: exponential growth, compressed to a fixed duration.
    const points=Array.from({length:61},(_,i)=>{
        const x=24+i/60*312, value=Math.exp(Math.log(target)*i/60);
        return [x,164-(value-1)/(max-1)*132];
    });
    return {path:points.map(([x,y],i)=>`${i?'L':'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' '),end:points.at(-1)};
}
export function createGameRenderer(root, {onPhase = () => {}} = {}) {
    let playToken=0, active=[], ticket=0, disposed=false, slow=false, hover=false;
    const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
    const stop = () => {playToken++;for(const a of active)a.cancel?.();active=[];};
    const rate = () => {for(const a of active) {if(a.updatePlaybackRate)a.updatePlaybackRate((slow || hover) ? .3 : 1);}};
    function run(node, frames, duration, delay=0) {
        if(!node?.animate || reduced() || document.hidden)return;
        const a=node.animate(frames,{duration,delay,easing:'cubic-bezier(.18,.65,.28,1)',fill:'both'});
        active.push(a);rate();return a;
    }
    const visibility=()=> {if(document.hidden)for(const a of active)a.finish?.();};
    document.addEventListener('visibilitychange',visibility);
    const preference=matchMedia('(prefers-reduced-motion: reduce)');
    preference.addEventListener?.('change',visibilityMotion);
    function visibilityMotion(){if(preference.matches)for(const a of active)a.finish?.();}
    function controls() {
        root.querySelector('[data-slow]')?.addEventListener('click',e=>{
            slow=!slow;e.currentTarget.setAttribute('aria-pressed',String(slow));rate();
        });
        const stage=root.querySelector('.game-stage');
        stage?.addEventListener('pointerenter',e=>{if(e.pointerType==='mouse'){hover=true;rate();}});
        stage?.addEventListener('pointerleave',()=>{hover=false;rate();});
    }
    function waiting(g) {
        root.innerHTML=`<div class="game-render" data-render-kind="${g.kind}"><div class="render-topline"><span>SPECTATING</span><span>Seed sealed</span></div><div class="game-stage game-waiting" aria-label="Waiting for the verified reveal">
        ${g.kind==='coin'?`<div class="coin-shadow"></div><div class="coin-flight"><div class="club-coin">${coinFace('HEADS')}${coinFace('TAILS')}</div></div><div class="side-plaques"><span>HEADS</span><span>TAILS</span></div>`
        :g.kind==='dice'?`<div class="dice-tray">${Array.from({length:6},()=>'<div class="blank-die">·</div>').join('')}</div>`
        :g.kind==='slots'?`<div class="reel-cabinet">${Array.from({length:3},()=>'<div class="reel-window reel-sealed">M</div>').join('')}</div>`
        :'<svg class="ascent-chart" viewBox="0 0 360 190" aria-hidden="true"><path class="chart-grid" d="M24 24V164H340 M24 120H340 M24 76H340"/><text x="30" y="155">1× · awaiting reveal</text></svg>'}
        </div><p class="render-caption">${g.kind==='crash'?'Targets are locked at entry. The ascent plays after the point is revealed.':'The table is set. The reveal will play here.'}</p><p class="render-live-note"></p></div>`;
        update(g);
    }
    function update(g) {
        const note=root.querySelector('.render-live-note');
        if(note)note.textContent=g.state==='open'?`${g.entry_count} seated · ${g.pot} tokens committed`:'Seats locked · awaiting the server’s verified reveal';
    }
    async function show(g,result,{autoplay=false}={}) {
        stop();const mine=++ticket;
        if(!result){waiting(g);return;}
        root.innerHTML='<p class="render-caption" role="status">Checking the reveal before playing…</p>';
        let checks;
        try {checks=await verify(result,g.id);}
        catch {checks=[];}
        if(disposed||mine!==ticket||!root.isConnected)return;
        if(!checks.length||!checks.every(c=>c.ok)){
            root.innerHTML='<p class="error" role="alert">Reveal verification failed. Playback is blocked. Inspect the proof below.</p>';
            return;
        }
        const order=new Map(result.manifest.map((row,i)=>[row[0],i]));
        const outcomes=[...result.outcomes].sort((a,b)=>order.get(a.account_id)-order.get(b.account_id));
        if(!outcomes.length||outcomes.every(o=>o.result.mode==='refund')){
            root.innerHTML=`<div class="game-render"><p class="render-caption">Verified · ${outcomes.length?'One seat. Stake returned; no draw.':'No entrants. No tokens moved; no draw to play.'}</p></div>`;
            return;
        }
        let index=Math.max(0,outcomes.findIndex(o=>o.payout===Math.max(...outcomes.map(o=>o.payout))));
        const label=(o,i)=>o.display_name||(o.handle?`@${o.handle}`:`Seat ${i+1}`);
        root.innerHTML=`<div class="game-render" data-render-kind="${g.kind}"><div class="render-topline"><span>${autoplay?'SPECTATING · REVEAL':'VERIFIED REPLAY'}</span><span>Proof checked ✓</span></div>
        <div class="game-stage" tabindex="0" aria-label="Verified game animation; hover for slow motion"></div>
        <p class="render-caption" role="status"></p>
        <div class="render-controls">${['dice','slots'].includes(g.kind)?`<label>Draw <select data-draw aria-label="Choose a muse’s draw">${outcomes.map((o,i)=>`<option value="${i}" ${i===index?'selected':''}>${esc(label(o,i))}${o.payout>0?' · paid':''}</option>`).join('')}</select></label>`:''}<button class="copy" data-replay>Replay round ↻</button><button class="copy" data-slow aria-pressed="false">Slow motion</button></div></div>`;
        slow=false;hover=false;controls();
        const stage=root.querySelector('.game-stage'),caption=root.querySelector('.render-caption');
        function play(animate) {
            stop();const playing=playToken;
            const o=outcomes[index],draw=o.result;
            if(g.kind==='coin') {
                stage.innerHTML=`<div class="coin-shadow"></div><div class="coin-flight"><div class="club-coin" style="transform:rotateY(${draw.side==='TAILS'?180:0}deg)">${coinFace('HEADS')}${coinFace('TAILS')}</div></div><div class="side-plaques"><span class="${draw.side==='HEADS'?'landed-side':''}">HEADS · ${result.manifest.filter(e=>e[1]===2).length}</span><span class="${draw.side==='TAILS'?'landed-side':''}">TAILS · ${result.manifest.filter(e=>e[1]===3).length}</span></div>`;
                const winners=outcomes.filter(o=>o.payout>0);
                caption.textContent=`${draw.side}. ${outcomes.every(o=>o.score===0)?'That side was empty; the occupied side takes the pool.':`${winners.length} ${winners.length===1?'muse takes':'muses share'} the pool.`} ${result.pot} tokens paid.`;
                if(animate){
                    run(stage.querySelector('.club-coin'),coinMotion(result.seed_reveal,draw.side),3300);
                    run(stage.querySelector('.coin-flight'),[{transform:'translateY(28px) scale(.85)',offset:0},{transform:'translateY(-42px) scale(1.08)',offset:.42},{transform:'translateY(15px) scale(.98)',offset:.86},{transform:'translateY(-7px) scale(1)',offset:.93},{transform:'translateY(0) scale(1)',offset:1}],3300);
                    run(stage.querySelector('.coin-shadow'),[{transform:'scale(.8)',opacity:.5},{transform:'scale(1.4)',opacity:.16,offset:.42},{transform:'scale(1)',opacity:.5}],3300);
                }
            } else if(g.kind==='dice') {
                stage.innerHTML=`<div class="dice-tray">${draw.dice.map(cube).join('')}</div><div class="dice-total ${o.score===Math.max(...outcomes.map(o=>o.score))?'winning-total':''}">${o.score}<small>${o.score===Math.max(...outcomes.map(o=>o.score))?'WINNING TOTAL':'TOTAL'}</small></div>`;
                caption.textContent=`${label(o,index)} · ${draw.dice.join(' + ')} = ${o.score}. ${o.payout} tokens paid.`;
                if(animate){
                    stage.querySelectorAll('.pip-cube').forEach((n,i)=>run(n,[{transform:`translateY(-65px) rotateX(${540+i*90}deg) rotateY(450deg) rotateZ(-35deg)`},{transform:'translateY(0) rotateX(0deg) rotateY(0deg) rotateZ(0deg)'}],1250+i*180,i*100));
                    run(stage.querySelector('.dice-total'),[{opacity:.15,transform:'scale(.9)'},{opacity:1,transform:'scale(1)'}],450,2650);
                }
            } else if(g.kind==='slots') {
                stage.innerHTML=`<div class="reel-cabinet">${draw.reels.map((value,i)=>{
                    const turns=3+i, cells=Array.from({length:turns*6},(_,j)=>(j%6)+1).concat(value);
                    return `<div class="reel-window" role="img" aria-label="Reel ${i+1}: symbol ${value}"><div class="symbol-strip" style="transform:translateY(-${(cells.length-1)*80}px)" data-distance="${(cells.length-1)*80}">${cells.map(v=>`<div class="reel-symbol"><span>${symbols[v-1]}</span><small>${v}</small></div>`).join('')}</div></div>`;
                }).join('')}</div>`;
                caption.textContent=`${label(o,index)} · symbols ${draw.reels.join(', ')}. ${Math.floor(o.score/100)===3?'Triple':Math.floor(o.score/100)===2?'Pair':'High symbol'} ${o.score%100} · ${o.payout} tokens paid.`;
                if(animate)stage.querySelectorAll('.symbol-strip').forEach((n,i)=>{
                    const distance=Number(n.dataset.distance);
                    run(n,[{transform:'translateY(0)',filter:'blur(0px)',offset:0},{transform:`translateY(-${distance*.65}px)`,filter:'blur(2px)',offset:.5},{transform:`translateY(-${distance+5}px)`,filter:'blur(0px)',offset:.94},{transform:`translateY(-${distance}px)`,filter:'blur(0px)',offset:1}],2000+i*550);
                });
            } else {
                const {path,end}=ascentPath(draw.crash_cents);
                stage.innerHTML=`<svg class="ascent-chart" viewBox="0 0 360 190" role="img" aria-label="Verified ascent stopped at ${draw.crash_cents/100} times">
                <path class="chart-grid" d="M24 24V164H340 M24 120H340 M24 76H340"/>
                <text x="26" y="185">1×</text><text x="170" y="185">REPLAY TIME →</text>
                <path class="ascent-curve" d="${path}" pathLength="1"/>
                <g class="crash-marker"><circle cx="${end[0]}" cy="${end[1]}" r="5"/><text x="${end[0]-8}" y="${Math.max(20,end[1]-12)}" text-anchor="end">${(draw.crash_cents/100).toFixed(2)}×</text></g></svg>`;
                caption.textContent=`Stopped at ${(draw.crash_cents/100).toFixed(2)}×. ${result.mode==='refund'?'All targets busted; stakes returned.':'Highest surviving target shares the pool.'} Recorded reveal; targets were fixed at entry.`;
                if(animate){
                    const a=run(stage.querySelector('.ascent-curve'),[{strokeDasharray:'1',strokeDashoffset:1},{strokeDasharray:'1',strokeDashoffset:0}],3300);
                    if(a)a.effect?.updateTiming({easing:'linear'});
                    run(stage.querySelector('.crash-marker'),[{opacity:0},{opacity:1}],250,3300);
                }
            }
            if(active.length) {
                onPhase('rolling');
                Promise.all(active.map(a=>a.finished)).then(()=>{
                    if(!disposed && playToken===playing)onPhase('paid out');
                }).catch(()=>{}); // Cancellation on navigation/replay is expected.
            } else onPhase('paid out');
        }
        root.querySelector('[data-replay]').onclick=()=>play(true);
        root.querySelector('[data-draw]')?.addEventListener('change',e=>{index=Number(e.target.value);play(true);});
        play(autoplay);
    }
    return {show,update,destroy(){disposed=true;ticket++;stop();document.removeEventListener('visibilitychange',visibility);preference.removeEventListener?.('change',visibilityMotion);}};
}

// Role: 在同一目的地详情中查看其他出发圈的具体车次。
// 契约：docs/specs/exploration.md；只消费 Views 的查询结果。
'use strict';
function bindViewJourneys(city) {
  document.querySelectorAll('[data-view-journeys]').forEach(button => {
    button.onclick = () => {
      const v = Views.views.find(v => v.id === Number(button.dataset.viewJourneys));
      const result = v && Views.results.get(v.id);
      if (!result?.ok) return;
      let holder = button.parentElement.querySelector('.view-journeys');
      if (!holder) { holder = document.createElement('div'); holder.className = 'view-journeys'; button.parentElement.append(holder); }
      const rows = [];
      for (const [stop, st] of result.stats) {
        if (STATIONS[stop].c !== city) continue;
        for (const journey of st.eligible) rows.push({journey, stop});
      }
      rows.sort((a,b)=>a.journey[0]-b.journey[0]);
      const ctx = {o:v.stops, f:v.dateOff*1440+v.fromMin, t:v.dateOff*1440+v.untilMin, cls:v.cls};
      renderStrip(rows.map(r=>r.journey),holder,{
        dayStart:ctx.f, stops:rows.map(r=>r.stop), ctx,
        labelOf:j=>`自${STATIONS[j[5]].n} `,
        arrOf:(j,i)=>` 到${STATIONS[rows[i].stop].n}`,
        listTitle:`${v.name} → ${city} 车次`,
        onBar:(j,stop)=>loadItinerary(j,stop,ctx),
      });
    };
  });
}

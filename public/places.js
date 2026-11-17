// Role: 跨时刻表版本保存和解析地点，不持久化数组下标。
// 契约：docs/specs/exploration.md；不拥有表单和查询结果。
'use strict';
const Places = (() => {
  function encode(place, stations) {
    const {stops, allStops, ...rest} = place;
    const type = place.type || (place.name === place.city ? 'city' : 'stn');
    return {...rest, type, stationNames: (stops || []).map(i => stations[i]?.n).filter(Boolean), schema: 1};
  }
  function resolve(place, stations) {
    if (!place || typeof place.name !== 'string') return null;
    const type = place.type || (place.name === place.city ? 'city' : 'stn');
    let stops;
    if (place.schema === 1 && Array.isArray(place.stationNames) && place.stationNames.length) {
      stops = place.stationNames.map(name => stations.findIndex(s => s.n === name));
      if (stops.some(i => i < 0)) return null;
    } else {
      // 旧数据只信任显示名称，绝不使用旧索引。
      stops = stations.flatMap((s, i) => (type === 'city' ? s.c === place.name : s.n === place.name) ? [i] : []);
    }
    if (!stops.length) return null;
    return {...place, type, stops: [...new Set(stops)], city: type === 'city' ? place.name : stations[stops[0]].c};
  }
  return {encode, resolve};
})();
if (typeof module !== 'undefined') module.exports = Places;

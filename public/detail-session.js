// Role: 详情与行程请求的有效期，防止旧异步响应覆盖新选择。
// 契约：docs/specs/exploration.md；不拥有查询或 DOM。
'use strict';
const DetailSession = (() => {
  let revision = 0, journey = 0, returns = 0;
  return {
    select() { revision++; journey++; returns++; },
    journey() { return [revision, ++journey]; },
    returns() { return [revision, ++returns]; },
    currentJourney(token) { return token[0] === revision && token[1] === journey; },
    currentReturns(token) { return token[0] === revision && token[1] === returns; },
  };
})();

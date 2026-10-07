/** Drain this owner and let systemd rebuild bot identity, cursor and intake. */
export function createTelegramTokenGuard(token:string,stop:AbortController){
 let changed=false;
 return {
  assertCurrent(current:string|undefined){if(current!==token){changed=true;stop.abort();throw Error('Telegram configuration requires restart');}},
  requireHealthy(){if(changed)throw Error('Telegram configuration requires restart');},
 };
}

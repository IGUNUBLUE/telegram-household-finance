export function executorMode(value?:string):'edge'|'vps_subscription'{
 if(!value||value==='edge')return 'edge';
 if(value==='vps_subscription')return value;
 throw Error('Ejecutor financiero no válido');
}

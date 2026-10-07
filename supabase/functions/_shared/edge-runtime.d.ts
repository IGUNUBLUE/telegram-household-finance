/** Supabase background tasks survive the HTTP response. */
declare const EdgeRuntime:{waitUntil(task:Promise<unknown>):void};

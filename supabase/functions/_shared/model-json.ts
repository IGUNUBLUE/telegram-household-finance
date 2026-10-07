export function parseModelJson(text:string):unknown{
 const trimmed=text.trim();
 const fenced=trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
 return JSON.parse(fenced?fenced[1]:trimmed);
}

import test from 'node:test';import assert from 'node:assert/strict';
import {escapeMarkdownV2,telegramMarkdown,telegramParts} from '../supabase/functions/_shared/telegram-format.ts';
test('Telegram Markdown escapes all reserved characters from names and descriptions',()=>{
 const raw='_*[]()~`>#+-=|{}.!\\';assert.equal(escapeMarkdownV2(raw),Array.from(raw,c=>'\\'+c).join(''));
 assert.equal(telegramMarkdown('Autor: Alex_[x]\nBanco Alfa: $250,13 COP'),' *'.trim()+'Autor:* Alex\\_\\[x\\]\nBanco Alfa: *$250,13 COP*');
 assert.equal(telegramMarkdown('[Banco](https://fake.example)'),'\\[Banco\\]\\(https://fake\\.example\\)');
});
test('Receipts highlight headings and exact monetary values without altering negative signs',()=>{
 assert.equal(telegramMarkdown('📋 Movimiento #3\nBanco Alfa: -$250,13 COP'),' *'.trim()+'📋 Movimiento \\#3*\nBanco Alfa: *\\-$250,13 COP*');
 assert.equal(telegramMarkdown('Hola, ¿cómo estás?'),'Hola, ¿cómo estás?');
});
test('Long messages split before markup and preserve emoji and every character',()=>{
 const text='a'.repeat(3499)+'💬 $1.234.567,89 COP. '+ '_'.repeat(5000);
 const parts=telegramParts(text);assert.equal(parts.join(''),text);assert.ok(parts.every(p=>p.length<=3500));
 assert.ok(parts.every(p=>!/[\uD800-\uDBFF]$/.test(p)));assert.ok(parts.map(telegramMarkdown).every(p=>p.length>0));
});

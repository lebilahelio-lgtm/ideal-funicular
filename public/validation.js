// Shared rules for new registrations and product changes; existing records stay intact.
export const titleName=value=>String(value??'').normalize('NFC').replace(/(^|\s)(\p{L})/gu,(_,space,letter)=>space+letter.toLocaleUpperCase('pt-AO'));
export function nameError(value,product=false){
 const name=String(value??'').normalize('NFC').trim();
 if(!name||name.length>150)return 'Introduza um nome com até 150 caracteres.';
 if(product){
  if(!/^[\p{L}\p{M}\d ]+$/u.test(name)||! /\p{L}/u.test(name))return 'O produto deve conter letras e apenas espaços ou algarismos, sem caracteres especiais.';
  if((name.match(/\d/g)||[]).length>3)return 'O nome do produto pode conter no máximo 3 algarismos.';
 }else if(!/^(?:\p{L}[\p{L}\p{M}]*)(?: +\p{L}[\p{L}\p{M}]*)+$/u.test(name))return 'Introduza pelo menos dois nomes, apenas com letras e espaços.';
 return '';
}
export const gmailValid=value=>/^[a-z0-9]+(?:\.[a-z0-9]+)*@gmail\.com$/i.test(String(value??'').trim());

import test from 'node:test';
import assert from 'node:assert/strict';
import {titleName,descriptiveText,nameError,gmailValid} from '../public/validation.js';
test('person names need two words, Unicode letters and no symbols or digits',()=>{
 for(const name of ['Ana','Ana2 Silva','Ana-Silva','Ana @ Silva'])assert.ok(nameError(name));
 for(const name of ['Ana Silva','João da Conceição','Érica Álvares'])assert.equal(nameError(name),'');
 assert.equal(titleName('joão da conceição'),'João Da Conceição');
});
test('product names permit at most three individual digits and no punctuation',()=>{
 for(const name of ['Arroz 123','Óleo 5 L','Sabonete'])assert.equal(nameError(name,true),'');
 for(const name of ['Arroz 1234','Arroz 12 34','Óleo!','Arroz-Integral','123'])assert.ok(nameError(name,true));
});
test('Gmail addresses never allow internal whitespace or other domains',()=>{
 for(const email of ['nome@gmail.com','helio_lebila@gmail.com','nome12@gmail.com'])assert.ok(gmailValid(email));
 for(const email of ['NOME12@GMAIL.COM','nome.apelido@gmail.com','nome+apelido@gmail.com','nome-apelido@gmail.com','nome@@gmail.com','nome@gmail..com','nome apelido@gmail.com','nome@ gmail.com','nome\t@gmail.com','nome@gmail. com','nome@example.com','nome..apelido@gmail.com'])assert.equal(gmailValid(email),false);
});

test('descriptive fields capitalize initials and replace double underscores with hyphens',()=>{assert.equal(descriptiveText('alimentos__secos'),'Alimentos-Secos');assert.equal(descriptiveText('compra de arroz'),'Compra De Arroz');});

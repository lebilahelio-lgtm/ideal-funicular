# Avaliação da Loja Clara

Revisão efetuada em 30/10/2026. Escopo: código, requisitos, testes de integração, teste de navegador e reprodução de situações adicionais numa base temporária. Nenhum dado real foi alterado. Esta revisão não é uma auditoria de segurança completa nem validação fiscal.

## Atualização posterior à avaliação

A versão 1.1 TT LEBILA corrigiu a consulta do caixa ativo, a reserva indevida de emails antigos e o calendário dos relatórios (itens 4, 5 e 6 abaixo). Acrescentou liderança única, remoção lógica, transferência de propriedade, senhas fortes, filtros e recuperação com código de 2 minutos. O envio de email/SMS depende de configuração externa e ainda não foi validado com um fornecedor real. Os itens 1, 2 e 3 e as restantes lacunas operacionais continuam pendentes. A avaliação original abaixo é preservada como histórico, não como lista integral de defeitos atuais.

## Parecer

O projeto é um protótipo funcional para demonstração e testes controlados. Ainda não deve ser o único sistema responsável pelas vendas, pelo dinheiro e pelo stock de uma loja em operação. A disponibilização de uma aplicação acessível pelo utilizador continua por validar: o painel Index mostrado na conversa não comprovou ligação ao servidor Node.js.

## Problemas encontrados

1. **Alta — preço pode mudar sem confirmação do vendedor.** Em `server.js`, a venda usa o preço atual da base de dados, mas o carrinho não envia uma versão/preço esperado para detetar alterações. Reproduzido: produto mostrado a 100 Kz, alterado para 150 Kz por outro operador; pagamento de 200 Kz aceite, venda gravada a 150 Kz, sem reconfirmação. Deve haver conflito explícito, atualização do carrinho e confirmação antes de cobrar.

2. **Alta — falta proteção contra reenvio da mesma venda.** Dois pedidos iguais a `/api/sales` criaram dois recibos e duas saídas de stock. A interface desativa o botão durante o pedido, mas isso não resolve uma repetição após perda da resposta. Cada tentativa de venda precisa de um identificador único, com deduplicação transacional. Repetir o identificador deve devolver o recibo já criado.

3. **Alta antes de exposição pública — primeiro proprietário sem verificação externa.** Enquanto não existir uma conta, `/api/setup` permite cadastrar o proprietário sem autenticação. É um mecanismo de arranque, mas o primeiro visitante de uma instalação pública ainda vazia pode assumir o controlo. Concluir a configuração em acesso privado ou exigir um segredo de instalação temporário, removido após o primeiro cadastro.

4. **Média — caixa aberto pode desaparecer da interface.** A API devolve apenas os últimos 50 caixas e a interface procura o caixa aberto nessa lista. Reproduzido: um caixa antigo continuou aberto na base, mas deixou de aparecer após 50 registos posteriores. Consultar o caixa ativo separadamente do histórico paginado.

5. **Média — email antigo fica indevidamente reservado.** O campo legado `username` recebe o email inicial e não é atualizado ao alterar contactos. Reproduzido: depois de alterar o email do proprietário, cadastrar outra pessoa com o email antigo devolveu 409, apesar de o email já não estar em uso no campo de login. Migrar/remover a restrição legada, preservando as contas.

6. **Média — totais diários divergem do calendário de Angola.** Recibos apresentam Africa/Luanda, mas métricas e gráfico usam `date(created)` em UTC. Uma venda de 30/10 às 00:30 em Angola entra no agrupamento de 29/10. Aplicar o mesmo fuso aos limites de período, aos agrupamentos e aos rótulos do gráfico.

## Pontos positivos validados

- Login por email/BI, senhas geradas e protegidas com scrypt, alteração de senha e revogação de outras sessões.
- Cadastro restrito à gestão após o arranque; restrições de perfis no servidor.
- Nome, BI e nascimento protegidos contra alteração pela API, com trigger adicional na base.
- Venda e desconto de stock na mesma transação; teste de disputa de stock impediu venda superior ao disponível.
- Venda fracionada, descontos, troco, recibo, abertura e conferência de caixa.
- Histórico de compras e vendas com instante atribuído pelo servidor.
- Interface de computador e telemóvel validada no Chromium, sem erros de JavaScript no percurso executado.
- SQLite sem dependências externas é adequado a um piloto pequeno num único servidor; não foram feitos testes de carga nem validada operação em múltiplas instâncias.

## Lacunas funcionais e operacionais

- Sem faturas fiscalmente certificadas, impostos e identificação fiscal completa do estabelecimento.
- Sem lotes, validade e alertas de vencimento, relevantes para produtos alimentares.
- Sem devoluções, anulações justificadas, perdas, quebras e ajustes de inventário.
- Sem despesas, retiradas e reforços de caixa; compras não debitam o caixa automaticamente.
- Relatórios mostram receita, não lucro, custo das mercadorias vendidas ou margem por lote de compra.
- Históricos limitados a 100 vendas/entradas/atividades e 50 caixas, sem navegação para os restantes registos na interface.
- Sem backups automáticos, restauração testada, monitorização ou publicação pública validada.
- HTTPS e cookies Secure dependem da instalação; proteção de tentativas de login está em memória e precisa de validação com o proxy de produção.
- Falta teste físico com o leitor de código de barras, impressora e operadores da loja. O teste de navegador simula um leitor em modo teclado.
- Os testes atuais passam, mas não cobriam os seis problemas acima. São necessários testes específicos de reenvio, alteração concorrente de preço, grande histórico e fronteiras de dia, além de teste de recuperação após falha.

## Verificações executadas

- `npm test`: um cenário de integração completo passou, incluindo múltiplas verificações de autenticação, permissões, caixa e stock.
- `python3 tests/browser.py`: fluxo de cadastro, credenciais geradas, login, compras, venda por peso, recibo e apresentação móvel passou.
- Sondagens adicionais isoladas: confirmados reenvio de venda, alteração de preço, email legado e desaparecimento do caixa ativo. Confirmada divergência UTC/Angola por consulta SQL.

## Ordem recomendada

1. Resolver alterações de preço e duplicação de vendas, proteger o arranque e disponibilizar acesso real para o proprietário testar.
2. Corrigir caixa ativo, alteração de email e calendário dos relatórios, com testes de regressão.
3. Acrescentar backups e verificar restauração; configurar HTTPS e operação do servidor.
4. Implementar devoluções, ajustes de stock, lotes/validade, movimentos de caixa e paginação dos históricos.
5. Validar exigências fiscais e executar um piloto acompanhado, conciliando vendas e stock com registos paralelos antes da adoção definitiva.

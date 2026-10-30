# Loja Clara

Aplicação web em português para uma pequena loja. Node.js 24 e SQLite, sem dependências externas. A base de dados é criada automaticamente e não contém contas ou dados de exemplo.

## Executar

```sh
cd /workspace/ideal-funicular
npm start
```

Porta padrão: `3000`. No primeiro acesso, cadastre o proprietário com nome, BI, data de nascimento, telefone e email. Guarde a palavra-passe gerada, mostrada uma única vez, e entre com email ou BI. Depois cadastre produtos e utilizadores, registe entradas de stock, abra o caixa e comece a vender.

```sh
npm test
```

O teste usa uma base temporária isolada e cobre autenticação, stock, venda fracionada, concorrência, recibos, trocos, fecho de caixa e permissões.

## Funcionalidades

- Categorias livres; produtos vendidos em unidades, kg, g, litros e mL.
- Entradas por caixas, pacotes ou outra embalagem, com conteúdo e custo de aquisição. Stock total convertido para a unidade de venda, com até três casas decimais.
- Venda com pesquisa, leitor de código de barras USB/Bluetooth em modo teclado e carrinho. Código + Enter adiciona o produto; quantidades podem ser ajustadas. Leitura por câmara não implementada.
- Vendas e atualização de stock numa transação SQLite; preços, disponibilidade e permissões validados no servidor. Valores monetários em cêntimos de Kz.
- Caixa individual: fundo inicial, pagamentos em dinheiro/TPA/transferência e conferência no fecho. O dinheiro esperado exclui trocos e pagamentos eletrónicos.
- Recibos imprimíveis e reimprimíveis com vendedor, cliente, produtos, quantidades, preços, subtotal, desconto, total, valor entregue e troco.
- Indicadores de hoje, gráfico diário de 14 dias e comparação de receita de dois períodos de 7 dias. Períodos agregados em UTC; datas apresentadas em Angola. Sem vendas anteriores, não se inventa uma tendência. Receita não é lucro.
- Alertas de stock mínimo, exportação CSV das últimas 100 vendas visíveis e histórico das últimas 100 atividades.
- Proprietário gere todos os perfis; gerente gere vendedores e catálogo; vendedor consulta catálogo sem custos e os seus próprios caixas/recibos. Alterações de permissões revogam as sessões do utilizador afetado.

## Contas e autenticação

Todos os acessos ao sistema exigem login por **email ou BI e palavra-passe**. Não há cadastro público após a configuração única do primeiro proprietário. Somente gerentes e proprietários cadastram pessoas; gerentes não podem criar ou administrar outros gerentes/proprietários.

O cadastro exige nome, BI angolano (ex.: `009763932CA042`), nascimento, telefone e email. BI e email são únicos. Nome, BI e nascimento são imutáveis, com validação na API e proteção por trigger SQLite. Email e telefone podem ser alterados pelo titular ou pela gestão autorizada.

O servidor gera uma palavra-passe aleatória por conta, mostra-a uma única vez ao responsável pelo cadastro e guarda somente o hash scrypt. Entregue-a ao titular em privado. Em **A minha conta**, a pessoa pode alterar a palavra-passe, confirmando a atual; outras sessões são revogadas. A gestão pode repor palavras-passe de perfis que está autorizada a gerir, gerando outra senha e revogando as sessões anteriores. Não há envio automático por email.

Compras/entradas, vendas, recibos, caixas e atividades apresentam data e hora do registo, com segundos e fuso de Angola. O instante é atribuído pelo servidor em UTC; não é editável pelo operador. O histórico de compras fica em **Produtos e stock** e inclui responsável, quantidade, custo e referência.

A migração adiciona os novos campos sem apagar os registos. Contas de versões antigas sem email/BI precisam de migração de identidade antes de usar o novo login; o ambiente entregue não tinha contas anteriores.

## Dados e operação

Variáveis opcionais: `PORT`, `HOST`, `DATA_DIR` (padrão `./data`) e `COOKIE_SECURE=1` ao servir exclusivamente por HTTPS. Sessões duram 12 horas; palavras-passe são protegidas com scrypt e salt. Não exponha a aplicação diretamente à Internet sem HTTPS, cópias de segurança e revisão operacional de segurança.

A política de incorporação permite páginas da própria aplicação e da interface `chatgpt.com`. Para outro anfitrião de pré-visualização, configure `FRAME_ANCESTORS` com as origens HTTPS autorizadas, separadas por espaços. Numa instalação independente que não necessite de incorporação, use `FRAME_ANCESTORS="'none'"`. Esta configuração não cria uma ligação pública nem encaminha portas: essas capacidades dependem da plataforma onde a aplicação é executada.

Os dados persistem em `data/loja.sqlite`, com ficheiros WAL associados. Para uma cópia de segurança consistente, pare o servidor e copie a pasta `data` completa; teste a restauração numa pasta separada antes de depender da cópia. Reiniciar o servidor mantém utilizadores, stock e vendas. Não inclua a base de dados no Git.

## Limites desta versão

Os recibos são **comprovativos internos sem validade fiscal**, não faturas certificadas. A certificação fiscal, impostos e identificação fiscal do estabelecimento precisam de implementação conforme a legislação aplicável antes do uso fiscal. Esta versão também não inclui devoluções/anulações, vendas a crédito, movimentos manuais de saída do caixa, fornecedores estruturados, recuperação de palavra-passe por email, múltiplas lojas ou backups automáticos. Entradas de stock representam aquisições e não debitam automaticamente o caixa de vendas. O histórico da interface é limitado; os registos completos permanecem na base de dados. Não existe integração com balanças ou pagamento bancário: o método de pagamento é registado após confirmação pelo operador.

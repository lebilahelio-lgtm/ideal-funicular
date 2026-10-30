# TT LEBILA

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

Os testes usam bases temporárias isoladas e cobrem autenticação, stock, venda fracionada, concorrência, recibos, trocos, fecho de caixa e permissões.

## Funcionalidades

- Categorias livres; produtos vendidos em unidades, kg, g, litros e mL.
- Entradas por caixas, pacotes ou outra embalagem, com conteúdo e custo de aquisição. Stock total convertido para a unidade de venda, com até três casas decimais.
- Venda de vários produtos no mesmo carrinho e recibo, com subtotal por item e botão para continuar a adicionar produtos.
- Venda com pesquisa, leitor de código de barras USB/Bluetooth em modo teclado e carrinho. Código + Enter adiciona o produto; quantidades podem ser ajustadas. Leitura por câmara não implementada.
- Vendas e atualização de stock numa transação SQLite; preços, disponibilidade e permissões validados no servidor. Valores monetários em cêntimos de Kz.
- Validação partilhada entre interface e servidor: valor recebido insuficiente indica quanto falta; pagamento exato indica ausência de troco; dinheiro a mais calcula o troco; TPA/transferência exigem valor exato. Desconto acima do subtotal é rejeitado com o excesso indicado. Valores inválidos não criam venda nem descontam stock.
- Caixa individual: fundo inicial, pagamentos em dinheiro/TPA/transferência e conferência no fecho. O dinheiro esperado exclui trocos e pagamentos eletrónicos. No fecho, a diferença aparece durante a contagem: uma falta de dinheiro é avisada, mas pode ser registada para preservar o valor efetivamente contado. Não é necessário inventar um valor igual ao esperado para fechar o caixa.
- Recibos imprimíveis e reimprimíveis com vendedor, cliente, produtos, quantidades, preços, subtotal, desconto, total, valor entregue e troco.
- Indicadores de hoje, gráfico diário de 14 dias e comparação de receita de dois períodos de 7 dias. Períodos e datas apresentados segundo o calendário de Angola (UTC+1). Sem vendas anteriores, não se inventa uma tendência. Receita não é lucro.
- Alertas de stock mínimo, exportação CSV das últimas 100 vendas visíveis e histórico das últimas 100 atividades.
- Um único proprietário e no máximo um gerente; o proprietário gere a equipa, o gerente gere vendedores e catálogo; vendedor consulta catálogo sem custos e os seus próprios caixas/recibos. Alterações de permissões revogam as sessões do utilizador afetado.

## Contas e autenticação

Todos os acessos ao sistema exigem login por **email ou BI e palavra-passe**. Não há cadastro público após a configuração única do primeiro proprietário. Somente o gerente e o proprietário cadastram pessoas; o gerente não pode criar ou administrar outro gerente/proprietário.

O cadastro exige nome, BI angolano (ex.: `009763932CA042`), nascimento, telefone e email. BI e email são únicos. Nome, BI e nascimento são imutáveis, com validação na API e proteção por trigger SQLite. Email e telefone podem ser alterados pelo titular ou pela gestão autorizada.

O servidor gera uma palavra-passe aleatória por conta, mostra-a uma única vez ao responsável pelo cadastro e guarda somente o hash scrypt. Entregue-a ao titular em privado. A palavra-passe gerada contém letras, números e símbolos. As novas palavras-passe exigem pelo menos **8 caracteres**, letras, números e um carácter especial. Os botões com olho permitem ver/ocultar o que está a escrever. Em **A minha conta**, a pessoa pode alterar a palavra-passe, confirmando a atual; outras sessões são revogadas. A gestão pode repor palavras-passe de perfis que está autorizada a gerir, gerando outra senha e revogando as sessões anteriores. A recuperação automática depende da configuração descrita abaixo.

Compras/entradas, vendas, recibos, caixas e atividades apresentam data e hora do registo, com segundos e fuso de Angola. O instante é atribuído pelo servidor em UTC; não é editável pelo operador. O histórico de compras fica em **Produtos e stock** e inclui responsável, quantidade, custo e referência.

A migração adiciona os novos campos sem apagar os registos. Se uma versão antiga tiver mais de um proprietário ou gerente, mantém o primeiro ativo (ou o primeiro ID se nenhum estiver ativo) de cada perfil e converte os restantes em vendedores, registando a mudança no histórico. Contas removidas são desativadas e preservadas para os recibos e atividades; não são apagadas fisicamente. Um caixa aberto tem de ser fechado antes de remover o respetivo titular. O proprietário não pode ser removido nem remover-se: em **Transferir propriedade**, confirma a senha e escolhe outra pessoa ativa; o proprietário anterior passa a vendedor e ambas as sessões são terminadas. Contas de versões antigas sem email/BI precisam de migração de identidade antes de usar o novo login; o ambiente entregue não tinha contas anteriores.

## Recuperação de acesso

O botão **Esqueci a palavra-passe** permite pedir um código de 6 algarismos por email (Resend) ou SMS (Twilio). O destino é sempre o contacto já registado; o pedido não aceita destinos alternativos. O código expira aos **120 segundos**, só pode ser usado uma vez, permite no máximo 5 tentativas e é invalidado por um novo pedido. Há um intervalo mínimo de 60 segundos entre pedidos para a mesma identificação e limites por IP. Após validar o código, a sessão permite apenas definir uma nova palavra-passe; o acesso ao resto da loja fica bloqueado até essa alteração.

A senha antiga **não pode ser visualizada ou enviada**, pois só o seu hash é guardado. O código não é devolvido pela API nem escrito nos logs. Reiniciar o servidor invalida códigos pendentes. Códigos nunca substituem permanentemente uma palavra-passe.

Para ativar envio real, crie uma conta num dos fornecedores, configure um remetente autorizado e copie `.env.example` para `.env` na raiz do projeto. Preencha apenas os canais que usar:

- Email: `RESEND_API_KEY` e `RECOVERY_EMAIL_FROM` (endereço de um domínio verificado no Resend).
- SMS: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` e `TWILIO_FROM_NUMBER` (número de envio autorizado na Twilio).

`npm start` lê `.env` automaticamente em Node.js 24. Também pode definir estas variáveis como secrets no Codespaces e reiniciar a aplicação. Nunca publique credenciais no GitHub. Os destinos de rede são `api.resend.com` e `api.twilio.com`; autorize-os no ambiente de execução quando necessário. Sem configuração, a interface informa que o envio está desativado e permite voltar ao login; a gestão pode continuar a repor senhas manualmente. O proprietário único deve guardar as credenciais ou configurar um canal de recuperação para não ficar sem acesso.

Os testes usam um transporte simulado para os códigos, sem enviar mensagens reais. O envio real, a entrega ao destinatário e as condições comerciais de cada fornecedor precisam de ser validados depois de configurar a conta.

## Interface e filtros

A identidade TT LEBILA usa azul escuro e azul claro, tipografia maior e contraste reforçado. Cadastro e login partilham um fundo azul contínuo, com marca ampliada e centralizada e o texto de apresentação preservado. Campos obrigatórios exibem um asterisco vermelho, uma legenda e a indicação nativa/acessível `required`; filtros e campos opcionais não recebem o asterisco. A marcação acompanha os diálogos criados dinamicamente e os campos fiscais que só são obrigatórios ao ativar o cálculo. Campos de BI, nome, telefone, email e valores têm validação durante a escrita e no servidor. O BI exige 9 algarismos, 2 letras e 3 algarismos; os zeros iniciais são significativos e não são inventados pelo sistema.

Valores numéricos separam milhares com espaços enquanto escreve (`1 234 567,89`). Quantidades permitem até três casas decimais e dinheiro até duas. BI, telefone, código de barras e códigos temporários não recebem separadores de milhares. O envio converte os valores para números, sem os separadores.

Há pesquisa e categorias no catálogo e ponto de venda; os históricos de vendas, compras, caixas e atividades têm pesquisa, seleção de tipo e intervalo de datas. A equipa tem filtros de texto, perfil e estado. Estes filtros atuam sobre os registos carregados (limites documentados abaixo); não substituem paginação completa. Não há atualização em tempo real entre dispositivos.

## IVA e regras fiscais

Em **IVA e regras fiscais**, o proprietário define o enquadramento, NIF, morada, modo de preço, fundamento legal e regras por produto. O gerente pode classificar produtos e consultar o resumo, mas não alterar taxas nem o enquadramento. As regras distinguem tributação, isenção e não sujeição e têm datas de vigência. Produtos podem ser classificados individualmente no cadastro ou em grupo, sem alterar stock nem custos.

**O regime da TT LEBILA ainda não foi confirmado.** O módulo inicia pendente, sem taxas legais predefinidas. Vendas neste estado continuam como comprovativos internos, com IVA e base fiscal **não apurados**, nunca como uma isenção presumida. Ativar exige enquadramento suportado, NIF, morada, fundamento e confirmação do proprietário; com o cálculo ativo, produtos sem regra válida impedem a venda. Consulte [FISCALIDADE.md](FISCALIDADE.md) antes de ativar.

O cálculo distingue preços com IVA incluído e preços sem IVA, distribui o desconto pelos itens proporcionalmente e arredonda em cêntimos. O recibo mostra base, IVA e total por regra. Taxa, fundamento, empresa e modo de preço ficam guardados na venda: alterar regras depois não modifica recibos nem resumos históricos. Alterações durante um atendimento provocam conflito e exigem atualizar os preços/IVA antes de finalizar.

O relatório filtra todas as vendas do período, sem o limite de 100 do histórico geral. Identifica quantos comprovativos ainda têm imposto por apurar. Não é declaração de IVA, não inclui IVA dedutível nas compras e não faz apuramento específico do regime simplificado. O software continua sem certificação fiscal.

## Ecrã de gestão de caixa

O painel destaca o dinheiro esperado, fundo inicial, turno e responsável. Cartões separam vendas do turno, dinheiro, pagamentos eletrónicos e atendimentos. A distribuição por método usa todas as vendas do caixa ativo, sem o limite de 100 do histórico geral. Os últimos cinco recebimentos podem ser abertos para consultar o recibo. O histórico distingue conferência exata, falta e sobra, com os filtros existentes. Estados aberto, fechado e sem vendas têm apresentação própria; o resumo do turno pertence sempre ao utilizador autenticado, mesmo quando a gestão consulta caixas da equipa.

## Dados e operação

Variáveis opcionais: `PORT`, `HOST`, `DATA_DIR` (padrão `./data`) e `COOKIE_SECURE=1` ao servir exclusivamente por HTTPS. Sessões normais duram 12 horas; uma sessão de recuperação pendente dura até 10 minutos e só permite alterar a senha; palavras-passe são protegidas com scrypt e salt. Não exponha a aplicação diretamente à Internet sem HTTPS, cópias de segurança e revisão operacional de segurança.

A política de incorporação permite páginas da própria aplicação e da interface `chatgpt.com`. Para outro anfitrião de pré-visualização, configure `FRAME_ANCESTORS` com as origens HTTPS autorizadas, separadas por espaços. Numa instalação independente que não necessite de incorporação, use `FRAME_ANCESTORS="'none'"`. Esta configuração não cria uma ligação pública nem encaminha portas: essas capacidades dependem da plataforma onde a aplicação é executada.

Os dados persistem em `data/loja.sqlite`, com ficheiros WAL associados. Para uma cópia de segurança consistente, pare o servidor e copie a pasta `data` completa; teste a restauração numa pasta separada antes de depender da cópia. Reiniciar o servidor mantém utilizadores, stock e vendas. Não inclua a base de dados no Git.

## Limites desta versão

Os recibos são **comprovativos internos sem validade fiscal**, não faturas certificadas. A certificação fiscal, o enquadramento e as taxas legais aplicáveis precisam de confirmação antes de ativar o módulo. NIF e morada podem ser configurados, mas isso não certifica o software. Esta versão também não inclui devoluções/anulações, vendas a crédito, movimentos manuais de saída do caixa, fornecedores estruturados, múltiplas lojas ou backups automáticos. Entradas de stock representam aquisições e não debitam automaticamente o caixa de vendas. O histórico da interface é limitado; os registos completos permanecem na base de dados. Não existe integração com balanças ou pagamento bancário: o método de pagamento é registado após confirmação pelo operador.

## Teste de navegador opcional

Com Python Playwright instalado e Chromium disponível em `/usr/bin/chromium`, execute `python3 tests/browser.py`. O teste usa uma base separada e cobre cadastro de vendedor e gerente, resposta vazia, filtros, senhas, separação de milhares, venda por peso com vários produtos no mesmo recibo, insuficiência até um cêntimo, desconto inválido, excesso eletrónico, falta no caixa e layout móvel. Não altera a base real.

### Validação de nomes e contactos

Novos utilizadores precisam de pelo menos dois nomes, apenas com letras e espaços. As iniciais de cada palavra são convertidas em maiúsculas durante a escrita e no servidor. Os nomes de produtos aceitam letras, espaços e até três algarismos no total, sem pontuação. O telefone é opcional; quando preenchido, mantém a validação do indicativo. Nos cadastros e alterações de contactos, o email deve ser Gmail, apenas com letras minúsculas, números e sublinhado antes de @gmail.com, sem espaços nem pontos no nome (exemplo: helio_lebila@gmail.com). Os dados históricos e as identidades já registadas são preservados.

A janela de credenciais iniciais permite copiar a palavra-passe, mesmo quando está ocultada pelo botão de olho. A senha não fica guardada em texto legível. Em A minha conta, Recuperar acesso encaminha para o fluxo de recuperação existente; o envio de códigos depende de configurar Resend ou Twilio.

### Acessos por pessoa

Em **Equipa e permissões → Acesso**, o proprietário escolhe as áreas do gerente e de cada vendedor. O gerente, quando autorizado a gerir a equipa, pode definir os acessos dos vendedores, sem conceder acessos que não possui. O proprietário mantém sempre acesso total; ninguém altera o seu próprio acesso.

| Área ou operação | Gerente | Vendedor |
| --- | --- | --- |
| Visão geral, vendas, caixa, histórico de vendas e consulta de stock | Configurável pelo proprietário | Configurável pelo proprietário ou gerente autorizado |
| Cadastro/edição de produtos e entradas de stock | Configurável pelo proprietário | Sempre bloqueado |
| Atividades internas, consulta fiscal e gestão de equipa | Configurável pelo proprietário | Sempre bloqueado |
| Enquadramento, taxas fiscais e transferência de propriedade | Apenas proprietário | Sempre bloqueado |

Retirar a consulta de stock também retira a alteração direta. O ponto de venda continua a mostrar os produtos e quantidades disponíveis necessários para vender, sem custos de aquisição. As vendas baixam o stock automaticamente. Retirar o caixa impede vender; é necessário fechar um turno aberto antes de retirar esse acesso. Os vendedores veem apenas os seus próprios recibos e turnos. As restrições são verificadas no servidor, os dados administrativos não autorizados são omitidos da resposta e os menus acompanham as permissões. Alterações ficam na auditoria e terminam as sessões da pessoa afetada. As contas existentes conservam os acessos habituais até serem configuradas.

### Histórico de vendas por caixa e pessoa

O vendedor consulta exclusivamente vendas registadas por si nos seus próprios caixas, incluindo turnos anteriores. Não pode abrir recibos de outros vendedores nem escolher outra pessoa nos filtros. Gerente e proprietário, quando têm acesso ao histórico, podem escolher **Histórico geral**, **As minhas vendas** ou uma pessoa específica. A lista de pessoas inclui contas removidas com vendas históricas, sem expor contactos pessoais.

Os filtros de pessoa, caixa, pesquisa, pagamento e datas (horário de Angola) são aplicados no servidor sobre todo o histórico, com 50 vendas por página. O resumo mostra a contagem e o total de todas as vendas filtradas; **Exportar página CSV** exporta apenas a página apresentada, incluindo o número do caixa. As permissões configuradas pelo proprietário continuam a aplicar-se.

O histórico apresenta os rótulos curtos **Pesquisa recibo** e **Histórico geral**, com um seletor **Pesquisar por** (Recibo, Cliente ou Vendedor). A pesquisa é limitada à coluna escolhida. Os campos descritivos de categoria, embalagem, cliente, motivo de entrada, morada e nome da regra fiscal recebem iniciais maiúsculas durante a escrita e no servidor; duplos sublinhados nesses textos são convertidos em hífen. Emails, senhas, BI, códigos e textos legais mantêm as suas regras específicas. Os recibos antigos são preservados.

# Balcões, equipas, armazém e parceiros

## Começar

1. O proprietário entra em **Caixa → Definir balcões** e define entre 1 e 100 balcões físicos. Um balcão ocupado precisa de ser fechado antes de ser desativado. A desativação conserva todos os turnos anteriores.
2. Em **Equipa e permissões**, cadastra o gerente, atendentes, responsáveis de caixa, responsáveis de armazém e colaboradores de armazém. Em **Acesso**, escolhe as autorizações concretas. O proprietário mantém todas as responsabilidades sem precisar de outra conta; o gerente pode acumular funções de caixa e de armazém se o proprietário as autorizar.
3. Cada pessoa consulta **A minha conta → Código pessoal de caixa**. Para abrir um turno, escolhe um balcão livre, preenche o fundo inicial e introduz os quatro algarismos nos quadrados. O balcão fica ocupado por essa pessoa até ao fecho; nem uma segunda pessoa no mesmo balcão nem dois turnos simultâneos da mesma pessoa são permitidos.
4. O proprietário cadastra os parceiros ou delega consulta/edição ao gerente. O pessoal autorizado do armazém vê apenas os nomes dos fornecedores na seleção e pode usar **+ Fornecedor** para registar um novo com nome, telefone, email e localização. Não recebe a lista dos contactos completos.
5. O responsável do armazém define os produtos e os dados fixos. No stock global do produto, o colaborador autorizado usa **Nova compra** para registar fornecedor, quantidade, custo, data de compra e data de expiração. Cada compra cria um lote indisponível; a disponibilização é uma decisão posterior, nos detalhes desse lote.

## Perfis e acumulação de funções

As funções operacionais são guardadas separadamente da titularidade: continua a haver apenas um proprietário e um gerente. Há vários colaboradores por função. O perfil define o limite de acesso e as caixas de seleção definem o acesso efetivo.

| Perfil | Acesso inicial |
| --- | --- |
| Proprietário/diretor | Todas as áreas e responsabilidades; único a delegar consulta dos códigos da equipa |
| Gerente | Vendas, caixa, histórico, balcões, equipa e consulta fiscal; armazém, cancelamentos, parceiros e códigos precisam de delegação |
| Atendente | Vendas, próprio caixa, próprio histórico e stock disponível; sem alterações diretas de stock ou contactos de parceiros |
| Pessoal de armazém | Consulta de produtos/lotes, entradas, correções de fornecedor/validade, desperdícios, expirados e cadastro de fornecedor; sem dados fixos, vendas ou contactos completos |
| Responsável de armazém | Operações do armazém e definição dos produtos/dados fixos; consulta/classificação fiscal é delegável separadamente |
| Responsável de caixa | Atendimento, caixas e histórico, com autorização de cancelamento e reembolso; sem gestão da equipa ou contactos de parceiros |

O gerente autorizado a gerir a equipa só gere colaboradores, não outro gerente/proprietário, e não concede acessos que não possui. Não pode delegar a consulta de todos os códigos. As alterações de acesso terminam as sessões da pessoa afetada. A autorização é verificada no servidor em cada operação.

## Código pessoal

O código tem quatro algarismos, pode começar por zero e é exclusivo entre as contas com códigos atribuídos. É suplementar ao login por email/BI e palavra-passe: não inicia sessão nem identifica outra pessoa. Expira sete dias depois da emissão. A consulta e a abertura verificam o prazo e emitem um código diferente quando necessário; o anterior deixa de funcionar. Cinco tentativas incorretas bloqueiam novas tentativas por cinco minutos, inclusive se a abertura falhar.

Só o titular recebe o seu código em **A minha conta**. O proprietário pode consultar os códigos da equipa e delegar essa consulta ao gerente. Os códigos não são devolvidos no estado geral, nas listas de equipa, nas auditorias ou nos registos de erro. São guardados cifrados com AES-256-GCM; a chave fica em `DATA_DIR/cash-pin.key`, fora do Git e com permissões de ficheiro restritas.

**Backup e recuperação:** guarde a base SQLite e `cash-pin.key` juntos, em local protegido. Se existirem códigos cifrados e a chave faltar, a aplicação recusa iniciar para evitar criar uma chave incompatível. Restaurar a base sem a respetiva chave não permite consultar esses códigos. O domínio de quatro algarismos é finito; a emissão recusa quando não há combinação livre, sem repetir códigos.

## Balcão físico e turno

O balcão é um posto físico reutilizável. O turno é cada abertura por uma pessoa, com fundo inicial, vendas, fecho e conferência próprios. O histórico identifica ambos. Um atendente só lê recibos e turnos da própria autoria nos seus próprios caixas; escolher o balcão de outra pessoa não dá acesso a essas vendas. O responsável de caixa autorizado pode consultar as vendas necessárias ao cancelamento. Gerente/proprietário com acesso ao histórico filtram a equipa, o balcão e o turno.

Na migração, os turnos antigos são associados a balcões por utilizador, pois a versão anterior não guardava o número do balcão físico. Essa associação não pretende reconstruir a disposição histórica real da loja. Os números futuros são configurados pela direção. As vendas, compras, quantidades e valores anteriores mantêm-se.

## Catálogo, disponibilização, lotes e saídas

O menu **Armazém** apresenta uma lista compacta do stock global por produto. **Nova compra** só aparece nessa lista; **Ver detalhes** abre os dados do produto e os seus lotes. Não há tabelas globais de lotes nem custos e definições técnicas permanentemente expostos. O histórico completo abre por botão, com pesquisa e filtros.

Cada nova compra exige data de compra e data de expiração e cria um lote indisponível, mesmo se outros lotes do produto já estiverem à venda. **Disponibilizar lote** autoriza apenas o lote escolhido. A compra nunca pode apontar para um lote existente nem definir a sua disponibilidade. A correção de dados do lote não pode alterar a quantidade comprada, quantidade restante nem a data da compra. A única entrada adicional num lote existente é uma devolução de venda com motivo e recibo, descrita abaixo.

Cada compra cria um lote. Os lotes têm fornecedor, data/hora da entrada, validade, quantidade inicial e quantidade restante. Os dados de produtos e as quantidades históricas não são substituídos por uma correção de lote: essa correção é registada na auditoria com os valores anteriores e novos. Para acrescentar quantidade comprada, regista-se outra entrada.

O método implementado é **FIFO**: a compra com data mais antiga sai primeiro, com desempate pela data/hora do registo e ID do lote, entre os lotes disponibilizados. A validade não muda essa prioridade, mas lotes expirados ou sem validade obrigatória confirmada são excluídos da venda. O desconto dos lotes, a venda, os itens e os movimentos de saída são uma única transação. Cada saída guarda lote, quantidade, pessoa, data e recibo.

A validade é considerada até ao fim do dia indicado, segundo Angola. Lotes já expirados são excluídos do stock vendável; continuam no stock físico até à saída. Um produto definido como sujeito a validade exige uma data nas novas entradas e não vende lotes sem data confirmada. Os alertas aparecem em **Armazém** quando o prazo em dias configurado no produto é atingido, além dos alertas de lotes antigos por verificar.

O stock anterior é migrado para lotes identificados como antigos, sem inventar fornecedor ou validade. O pessoal autorizado confirma esses dados. Para desperdícios, prazo expirado e outras saídas, escolhe o lote, a quantidade e um motivo obrigatório. A saída conserva data, hora, pessoa, tipo e motivo. Um lote não expirado não pode ser retirado como expirado. Quantidades insuficientes ou unidades fracionárias incompatíveis são rejeitadas.

## Cancelamentos e reembolsos

Só quem tem **Responsável de caixa - cancelar vendas e reembolsar** pode cancelar, indicando um motivo. A opção **Registar devolução**, nos detalhes de um lote, exige um recibo que tenha usado esse lote e um motivo obrigatório; usa este mesmo cancelamento integral e registo de reembolso, sem permitir quantidades arbitrárias nem criar compras adicionais. É um cancelamento integral; não há devoluções parciais nesta implementação. A venda, os itens, valores e regras fiscais originais não são alterados. Uma tabela separada guarda a pessoa, a data, o motivo e o reembolso. O recibo e o histórico mostram **Cancelada**; o CSV identifica o estado. A repetição é bloqueada e a reposição dos lotes não pode ocorrer duas vezes.

Os produtos voltam aos lotes originais. Se a validade entretanto tiver passado, continuam fora do stock vendável. Para vendas antigas sem alocações, a devolução fica num lote antigo por verificar, sem inventar uma validade. O cancelamento pressupõe que a mercadoria volta ao stock físico; se estiver inutilizável, deve seguir-se uma saída por desperdício/expiração com motivo.

Em dinheiro, o reembolso é registado no turno original se estiver aberto. Se estiver fechado, o responsável precisa de um turno seu aberto com dinheiro suficiente; o reembolso é registado nesse turno e não altera a conferência antiga. O esperado em caixa é fundo inicial + vendas em dinheiro - reembolsos desse turno. TPA/transferências têm a devolução registada, mas o operador executa e confirma o reembolso bancário fora da aplicação.

Indicadores de vendas e resumo interno de IVA excluem vendas canceladas. Os históricos continuam a apresentar as vendas originais, e a contagem de resultados inclui os registos cancelados. O resumo não substitui notas de crédito nem regularizações fiscais legais; os comprovativos continuam internos e sem certificação fiscal.

## Proteção dos históricos e limites

Não há operações de apagar históricos. Triggers SQLite bloqueiam `DELETE` e `UPDATE` nas vendas, itens, compras/movimentos, auditorias, alocações e cancelamentos, inclusive para as contas de direção. Correções operacionais usam novos movimentos ou registos separados. Quem administra diretamente os ficheiros e o motor SQLite continua a ter controlo técnico sobre esses ficheiros; a aplicação não substitui backups e controlo de acesso ao servidor.

Os históricos de vendas e de movimentos do armazém são paginados, com 50 registos por página e filtros aplicados sobre todo o histórico. O armazém permite filtrar por pesquisa, produto, tipo, direção e intervalo de datas de Angola. Não foram adicionados execução automática de reembolsos bancários, vendas a crédito, múltiplas lojas, notas de crédito fiscais, devoluções parciais, backups automáticos ou movimentações gerais de tesouraria. Os testes de fornecedores usam dados fictícios e não contactam terceiros.

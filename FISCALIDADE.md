# IVA na TT LEBILA: configuração e limites

Estado em 30/10/2026: o proprietário ainda não sabe o enquadramento fiscal da empresa. O acesso do agente ao portal oficial da AGT foi recusado pela política de rede; não foi possível confirmar a legislação consolidada em vigor. **Este projeto não contém uma tabela de taxas legalmente verificada para alimentos ou higiene.** Taxas usadas nos testes são apenas exemplos aritméticos, em bases temporárias.

## Antes de ativar

Confirme com o contabilista ou a AGT:

1. O regime efetivo da empresa e a data a partir da qual se aplica.
2. O NIF e a identificação do estabelecimento.
3. A taxa ou fundamento de isenção/não sujeição de cada produto, segundo a classificação e os diplomas em vigor. A categoria comercial «Alimentares» não basta para decidir.
4. Se os preços do catálogo incluem IVA ou se este será acrescido ao preço. Alterar este modo no sistema **não converte os preços existentes**.
5. Os documentos, certificação de software e demais obrigações exigidos para emitir faturas legais.

Fontes oficiais para consulta e confirmação, não verificadas nesta execução:

- Administração Geral Tributária: https://agt.minfin.gov.ao/
- Ministério das Finanças: https://minfin.gov.ao/
- Portal do Contribuinte: https://portaldocontribuinte.minfin.gov.ao/

Foi guardado no rascunho do ambiente o pedido de permitir estes três domínios. Guardar um rascunho não aplica a política de rede; é necessário rever e guardar/publicar as definições do ambiente para a consulta futura. Isto não configura o Codespaces nem torna uma taxa legalmente confirmada.

## Estado pendente

É a opção inicial e deve manter-se enquanto o regime for desconhecido. O sistema não presume isenção nem 0%: grava `fiscal_state=pending` e valores fiscais nulos. O comprovativo apresenta «IVA não apurado». O preço recebido é o preço comercial registado, com os descontos, sem uma nova cobrança de imposto presumida. Estes documentos são internos e não substituem faturas legais.

Vendas anteriores à introdução do módulo são marcadas `legacy`, com imposto/base nulos. Não são recalculadas nem consideradas isentas nos relatórios.

## Regimes e regras

O cálculo ativável cobre liquidação de IVA por produto no regime geral e operações sem liquidação no regime de exclusão, mediante configuração expressa e validação externa. No regime de exclusão, uma regra tributada é bloqueada. A ativação do regime simplificado é bloqueada porque o seu apuramento específico não foi implementado. Não se deve escolher outro regime apenas para contornar esse bloqueio.

Cada regra contém nome, tipo (`tributado`, `isento` ou `nao_sujeito`), taxa, fundamento legal, início/fim de vigência e estado. Isenção e não sujeição têm valor zero de imposto, mas são situações distintas e conservam fundamentos distintos. Não há códigos fiscais/SAF-T presumidos.

Só o proprietário cria/altera regras e ativa o enquadramento. O gerente ou proprietário pode associar regras aos produtos, um a um ou em grupo. A atribuição não altera quantidades ou custos de stock. Uma regra inativa, fora da vigência ou inexistente impede a venda quando o cálculo estiver ativo. A vigência é avaliada na data da venda em Angola.

## Cálculo e descontos

Valores monetários são guardados em cêntimos. O desconto total é distribuído proporcionalmente ao valor dos itens, com o método dos maiores restos para que a soma das parcelas coincida exatamente com o desconto. Em caso de empate, a ordem dos itens decide o cêntimo restante.

- **Preço com IVA incluído:** o desconto reduz o preço bruto; a base é extraída desse valor e o IVA é a diferença entre bruto e base. O imposto não é somado uma segunda vez.
- **Preço sem IVA:** o desconto reduz a base; o IVA é calculado sobre a base remanescente e acrescido ao total.
- **Isento/não sujeito:** a base comercial é discriminada com imposto zero e respetivo fundamento, quando o enquadramento estiver ativado.

A taxa é expressa com até duas casas decimais. O arredondamento do imposto/base é feito por linha, ao cêntimo mais próximo, com meio cêntimo arredondado para cima. As somas do comprovativo e do relatório usam essas linhas, sem recalcular pela taxa média. Confirme o método de arredondamento e as exigências de faturação aplicáveis antes de usar fiscalmente.

IVA na venda não é um desconto ao cliente. «IVA dedutível» das compras é outro processo: este módulo não calcula crédito fiscal nem IVA a entregar ao Estado.

## Histórico e relatório

Cada venda guarda um snapshot do enquadramento, modo de preço, identificação da empresa, taxa e fundamento por item, desconto por item, base, imposto e total. Um recibo reimpresso mantém os dados da venda original. O relatório consulta os snapshots de todas as vendas do intervalo, segundo a data angolana, e identifica separadamente documentos pendentes/antigos. Não transforma esses documentos em vendas isentas.

Se as regras ou o total esperado mudarem enquanto o vendedor prepara o carrinho, a API rejeita a finalização com conflito. O vendedor deve atualizar os preços/IVA, conferir os novos valores e só depois receber/finalizar.

## Não incluído

Certificação AGT, faturação legal completa, SAF-T, declaração de IVA, dedução do imposto das compras, imposto retido, regularizações, devoluções/notas de crédito, apuramento específico do regime simplificado e atualização automática de legislação/taxas. O resumo é uma ferramenta interna de gestão, não uma declaração pronta para submissão.

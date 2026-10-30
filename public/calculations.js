export const formatMoney=value=>new Intl.NumberFormat('pt-AO',{style:'currency',currency:'AOA',maximumFractionDigits:2}).format(value/100);
const valid=value=>Number.isSafeInteger(value)&&value>=0;

// All amounts are integer cents, shared by the API and the checkout.
export function compareAmounts(expected,received){
 if(!valid(expected)||!valid(received))return {ok:false,error:'Introduza valores monetários válidos e não negativos.'};
 const difference=received-expected;
 return {ok:true,difference,shortfall:Math.max(0,-difference),excess:Math.max(0,difference)};
}

export function settlement(subtotal,discount,paid,method){
 if(!valid(subtotal)||!valid(discount))return {ok:false,error:'Subtotal ou desconto inválido.'};
 if(discount>subtotal)return {ok:false,error:`O desconto excede o subtotal em ${formatMoney(discount-subtotal)}. Reduza o desconto.`};
 const total=subtotal-discount;
 if(paid===null)return {ok:false,total,error:'Indique o valor recebido do cliente.'};
 const comparison=compareAmounts(total,paid);
 if(!comparison.ok)return {...comparison,total};
 if(comparison.shortfall)return {...comparison,ok:false,total,change:0,error:`Valor recebido insuficiente. Faltam ${formatMoney(comparison.shortfall)} para completar o pagamento.`};
 if(!['dinheiro','transferencia','tpa'].includes(method))return {ok:false,total,error:'Selecione um método de pagamento válido.'};
 if(method!=='dinheiro'&&comparison.excess)return {...comparison,ok:false,total,change:0,error:`O pagamento eletrónico excede o total em ${formatMoney(comparison.excess)}. Registe o valor exato de ${formatMoney(total)}; não há troco neste método.`};
 return {...comparison,ok:true,total,change:comparison.excess};
}

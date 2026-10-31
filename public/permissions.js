export const permissionLabels={dashboard:'Visão geral e indicadores',sales:'Ponto de venda',products:'Consultar produtos e stock',cash:'Operar o próprio caixa',history:'Histórico de vendas',stock_edit:'Responsável do armazém - produtos e dados fixos',stock_entry:'Registar compras e corrigir validade / fornecedor dos lotes',stock_exit:'Registar desperdícios e produtos expirados',warehouse:'Consultar armazém, lotes e alertas de validade',cash_manage:'Definir balcões e consultar ocupação',sales_cancel:'Responsável de caixa - cancelar vendas e reembolsar',view_all_pins:'Consultar códigos pessoais de todos (delegação exclusiva do proprietário)',partners_view:'Consultar parceiros e contactos completos',partners_edit:'Cadastrar e editar todos os parceiros',supplier_create:'Cadastrar fornecedor durante uma entrada',activity:'Histórico de atividades internas',fiscal:'Consulta fiscal e classificação de IVA',users:'Gerir equipa e acessos dos colaboradores'};
export const profileLabels={vendedor:'Atendente',armazem:'Pessoal do armazém',responsavel_armazem:'Responsável do armazém',responsavel_caixa:'Responsável de caixa',gerente:'Gerente'};
export const sellerKeys=['dashboard','sales','products','cash','history'];
export function permissionKeys(role,job='atendente'){
 if(role!=='vendedor')return Object.keys(permissionLabels);
 if(job==='armazem'||job==='responsavel_armazem')return ['products','stock_entry','stock_exit','warehouse','supplier_create',...(job==='responsavel_armazem'?['stock_edit','fiscal']:[])];
 if(job==='responsavel_caixa')return [...sellerKeys,'sales_cancel'];
 return sellerKeys;
}
export function permissions(role,stored={},job='atendente'){
 const keys=permissionKeys(role,job),disabledForManager=['stock_edit','stock_entry','stock_exit','warehouse','sales_cancel','view_all_pins','partners_view','partners_edit','supplier_create'];
 const result=Object.fromEntries(Object.keys(permissionLabels).map(key=>[key,keys.includes(key)&&(role!=='gerente'||!disabledForManager.includes(key))]));
 if(role==='proprietario')return result;
 if(role==='vendedor'&&job==='responsavel_armazem')result.fiscal=false;
 for(const key of Object.keys(result))if(typeof stored[key]==='boolean')result[key]=stored[key]&&keys.includes(key);
 if(!result.products)result.stock_edit=false;
 if(!result.cash)result.sales=false;
 if(!result.partners_view)result.partners_edit=false;
 return result;
}

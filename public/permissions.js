export const permissionLabels={dashboard:'Visão geral e indicadores',sales:'Ponto de venda',products:'Consulta de produtos e stock disponível',cash:'Caixa',history:'Histórico de vendas',stock_edit:'Cadastrar e editar produtos / adicionar stock',activity:'Histórico de atividades internas',fiscal:'Consulta fiscal e classificação de IVA',users:'Gestão da equipa e acesso dos vendedores'};
export const sellerKeys=['dashboard','sales','products','cash','history'];
export function permissions(role,stored={}){
 const result=Object.fromEntries(Object.keys(permissionLabels).map(key=>[key,role!=='vendedor'||sellerKeys.includes(key)]));
 if(role==='proprietario')return result;
 for(const key of Object.keys(result))if(typeof stored[key]==='boolean')result[key]=stored[key]&&(role!=='vendedor'||sellerKeys.includes(key));
 if(!result.products)result.stock_edit=false;
 // A sale requires an open cash register.
 if(!result.cash)result.sales=false;
 return result;
}

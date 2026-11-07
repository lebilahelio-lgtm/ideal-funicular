import os, subprocess, tempfile, time, shutil, sqlite3, json, re, datetime
from pathlib import Path
Path("/tmp/loja-ui-test").mkdir(exist_ok=True)
from playwright.sync_api import sync_playwright, expect
def assert_required_markers(page):
    missing=page.evaluate("""()=>Array.from(document.querySelectorAll('input:required,select:required,textarea:required')).filter(el=>el.offsetParent!==null).filter(el=>el.getAttribute('aria-required')!=='true'||!Array.from(el.labels||[]).some(label=>label.querySelector('.required-marker'))).map(el=>el.id||el.name)""")
    assert missing==[], 'Required fields without red markers or accessibility state: '+str(missing)

def open_warehouse_drawer(page,product_id):
    row=page.locator('[data-catalog-product="'+str(product_id)+'"]')
    row.wait_for()
    if row.get_attribute('aria-expanded')!='true':
        row.locator('[data-warehouse-toggle]').click()
    expect(page.locator('[data-product-drawer="'+str(product_id)+'"]')).to_have_attribute('aria-hidden','false')


folder=tempfile.mkdtemp(prefix='loja-browser-')
proc=subprocess.Popen(['node','server.js'],cwd=str(Path(__file__).resolve().parent.parent),env={**os.environ,'PORT':'3001','DATA_DIR':folder},stdout=subprocess.PIPE,stderr=subprocess.PIPE)
try:
    proc.stdout.readline()
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
        page=browser.new_page(viewport={'width':1440,'height':1050})
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('http://127.0.0.1:3001')
        page.get_by_role('heading',name='Cadastrar o proprietário').wait_for()
        assert_required_markers(page)
        assert page.locator('#auth-form input[required]').count()==4
        assert page.locator('#auth-form .required-marker').count()==5
        assert float(page.locator('.auth-hero .brand-name').evaluate('(el)=>parseFloat(getComputedStyle(el).fontSize)'))>=40
        brand=page.locator('.auth-hero .brand').bounding_box()
        assert abs(brand['x']+brand['width']/2-720)<3
        assert page.locator('#name').evaluate("el=>{const color=getComputedStyle(el.labels[0].querySelector('.required-marker')).color;const values=color.match(/\\d+/g).map(Number);return values[0]>values[1]*1.5&&values[0]>values[2];}")
        page.screenshot(path='/tmp/loja-ui-test/cadastro-azul.png',full_page=True)
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        brand=page.locator('.auth-hero .brand').bounding_box()
        assert abs(brand['x']+brand['width']/2-195)<3
        page.screenshot(path='/tmp/loja-ui-test/cadastro-azul-mobile.png',full_page=True)
        page.set_viewport_size({'width':1440,'height':1050})
        page.locator('#name').fill('ana silva')
        assert page.locator('#name').input_value()=='Ana Silva'
        assert not page.locator('#phone').evaluate('(el)=>el.required')
        page.locator('#email').fill('ana silva@gmail.com')
        assert not page.locator('#email').evaluate('(el)=>el.checkValidity()')
        page.locator('#bi').fill('009763932CA042')
        page.locator('#birth_date').fill('1990-02-28')
        page.locator('#phone').fill('+244923456789')
        page.locator('#email').fill('ANA@GMAIL.COM')
        assert page.locator('#email').input_value()=='ana@gmail.com'
        page.get_by_role('button',name='Criar conta do proprietário').click()
        page.locator('.credential code').wait_for()
        initial_password=page.locator('.credential code').inner_text()
        page.context.grant_permissions(['clipboard-read','clipboard-write'])
        page.get_by_role('button',name='Ocultar palavra-passe',exact=True).click()
        page.get_by_role('button',name='Copiar palavra-passe',exact=True).click()
        page.get_by_text('Palavra-passe copiada.',exact=True).wait_for()
        assert page.evaluate('navigator.clipboard.readText()')==initial_password
        page.locator('#modal').get_by_role('button',name='Mostrar palavra-passe',exact=True).click()
        page.get_by_role('button',name='Já guardei a palavra-passe').click()
        page.screenshot(path='/tmp/loja-ui-test/tt-login.png',full_page=True)
        page.locator('#identifier').fill('ana@gmail.com')
        page.locator('#password').fill(initial_password)
        page.get_by_role('button',name='Mostrar palavra-passe',exact=True).click()
        assert page.locator('#password').get_attribute('type')=='text'
        page.get_by_role('button',name='Ocultar palavra-passe',exact=True).click()
        page.get_by_role('button',name='Iniciar sessão').click()
        page.get_by_role('heading',name='Crie uma nova palavra-passe',exact=True).wait_for()
        assert page.locator('.sidebar').count()==0
        assert 'PRIMEIRO ACESSO' in page.locator('.eyebrow').inner_text()
        page.reload()
        page.get_by_role('heading',name='Crie uma nova palavra-passe',exact=True).wait_for()
        page.locator('#password').fill('PrimeiroAcesso123!')
        page.locator('#confirmation').fill('PrimeiroAcesso123!')
        page.get_by_role('button',name='Guardar e entrar na loja').click()
        initial_password='PrimeiroAcesso123!'
        page.get_by_role('heading',name='Visão geral',exact=True).wait_for()
        page.get_by_role('button',name='Armazém',exact=True).click()
        page.get_by_role('button',name='Adicionar produto').click()
        assert_required_markers(page)
        assert not page.locator('#tax_rule_id').evaluate('(el)=>el.required')
        assert page.locator('#pack_type').input_value()==''
        assert page.locator('#pack_type').evaluate('(el)=>el.required')
        assert not page.locator('#pack_size').evaluate('(el)=>el.checkValidity()')
        assert page.locator('#packaging-types [role=option]').evaluate_all('(els)=>els.map(el=>el.dataset.packaging)')==['Caixa','Fita','Pacote','Saco','Sesto']
        assert page.locator('#product-form [data-number]:not(#pack_cost)').evaluate_all('(els)=>els.every(el=>el.value==="0")')
        assert page.locator('#pack_cost').input_value()==''
        assert not page.locator('#pack_cost').evaluate('(el)=>el.required')
        page.locator('#pack_type').focus()
        page.keyboard.press('ArrowDown')
        page.keyboard.press('Enter')
        assert page.locator('#pack_type').input_value()=='Caixa'
        assert page.locator('#packaging-types').is_hidden()
        page.locator('#pack_type').fill('')
        page.locator('#name').fill('Arroz Branco')
        page.mouse.click(8,8)
        assert page.locator('#modal').evaluate('(el)=>el.open')
        assert page.locator('#name').input_value()=='Arroz Branco'
        page.keyboard.press('Escape')
        assert page.locator('#modal').evaluate('(el)=>el.open')
        assert page.locator('#name').input_value()=='Arroz Branco'
        assert page.locator('.modal-close').evaluate('(el)=>{const c=getComputedStyle(el).backgroundColor.match(/\\d+/g).map(Number);return c[0]>c[1]*2&&c[0]>c[2]*2;}')
        page.screenshot(path='/tmp/loja-ui-test/modal-azul-fecho.png')
        page.locator('#category').fill('alimentos__secos')
        assert page.locator('#category').input_value()=='Alimentos-Secos'
        page.locator('#unit').select_option('kg')
        page.locator('#product-extra summary').click()
        page.set_viewport_size({'width':390,'height':640})
        result=page.locator('#modal').evaluate("""dialog=>{
            const body=dialog.querySelector('.modal-body'),head=dialog.querySelector('.modal-head');
            const before=head.getBoundingClientRect().top;
            body.scrollTop=body.scrollHeight;
            return {scrollable:body.scrollHeight>body.clientHeight,scrolled:body.scrollTop>0,headFixed:Math.abs(head.getBoundingClientRect().top-before)<1,dialogScroll:dialog.scrollTop,bodyBelowHeader:body.getBoundingClientRect().top>=head.getBoundingClientRect().bottom-1};
        }""")
        assert result['scrollable'] and result['scrolled'] and result['headFixed'] and result['dialogScroll']==0 and result['bodyBelowHeader'], result
        page.locator('#modal .modal-body').evaluate('el=>el.scrollTop=0')
        page.set_viewport_size({'width':1440,'height':1050})
        page.locator('#barcode').fill('12345')
        page.locator('#pack_type').fill('Saco')
        page.locator('#pack_size').fill('25')
        page.locator('#expiry_warning_days').fill('7')
        page.locator('#pack_cost').fill('20000')
        page.locator('#price').fill('0')
        assert not page.locator('#price').evaluate('el=>el.checkValidity()'), 'zero sale price must be invalid'
        page.locator('#price').fill('0.01')
        assert page.locator('#price').evaluate('el=>el.checkValidity()'), 'one cent sale price must be valid'
        page.locator('#price').fill('1000')
        assert page.locator('#price').input_value()=='1 000'
        assert page.locator('#sale_enabled').count()==0
        # Saving keeps the modal open until the state request finishes, so a following
        # operation cannot edit a form that an older refresh is about to replace.
        def check_refresh_order(route):
            assert page.locator('#modal').evaluate('(el)=>el.open'), 'modal closed before refresh completed'
            route.continue_()
        page.route('**/api/state',check_refresh_order,times=1)
        page.get_by_role('button',name='Guardar produto').click()
        open_warehouse_drawer(page,1)
        page.locator('[data-product-drawer="1"] [data-stock]').click()
        assert_required_markers(page)
        assert page.locator('#packs').input_value()=='0'
        assert page.locator('#pack_cost').input_value()=='20 000'
        page.locator('#pack_cost').fill('18000')
        supplier_gap=page.locator('#add-supplier').bounding_box()['y']-sum(page.locator('#supplier_id').bounding_box()[k] for k in ['y','height'])
        assert 0<=supplier_gap<=8
        page.locator('#add-supplier').click()
        assert page.locator('#partner-form [required]').evaluate_all('(els)=>els.map(el=>el.name)')==['partner_name','partner_location']
        assert page.locator('#partner-form input').evaluate_all('(els)=>els.map(el=>el.name)')==['partner_name','partner_location','partner_phone','partner_email']
        page.locator('#partner_name').fill('Fornecedor Teste')
        page.locator('#partner_phone').fill('923456789')
        page.locator('#partner_email').fill('compras@fornecedor.ao')
        page.locator('#partner_location').fill('Luanda')
        page.get_by_role('button',name='Guardar parceiro',exact=True).click()
        page.locator('#supplier_id option[value="1"]').wait_for(state='attached')
        assert page.locator('#pack_cost').input_value()=='18 000'
        page.locator('#purchased_on').fill('2020-01-01')
        page.locator('#expires_on').fill('2099-12-31')
        assert page.locator('#purchased_on').evaluate('(el)=>el.required')
        assert page.locator('#expires_on').evaluate('(el)=>el.required')
        page.locator('#packs').fill('2')
        page.locator('#stock-form details summary').click()
        page.locator('#reason').fill('Compra inicial')
        page.get_by_role('button',name='Guardar compra').click()
        page.locator('#modal').wait_for(state='hidden')
        assert page.request.get('http://127.0.0.1:3001/api/state').json()['sale_products']==[]
        open_warehouse_drawer(page,1)
        page.locator('[data-product-details="1"]').click()
        page.locator('[data-lot="1"] summary').click()
        assert page.locator('#modal [data-stock]').count()==0
        page.get_by_role('button',name='Disponibilizar lote',exact=True).click()
        page.locator('[data-lot-availability="1"][data-enabled=false]').wait_for(state='attached')
        page.locator('#modal .modal-close').click()
        page.get_by_role('button',name='Adicionar produto').click()
        page.locator('#name').fill('Sabonete')
        page.locator('#category').fill('Higiene')
        page.locator('#pack_type').fill('Caixa')
        page.locator('#product-extra summary').click()
        page.locator('#barcode').fill('67890')
        page.locator('#pack_size').fill('12')
        page.locator('#pack_cost').fill('3000')
        page.locator('#price').fill('500')
        page.get_by_role('button',name='Guardar produto').click()
        open_warehouse_drawer(page,2)
        page.locator('[data-product-drawer="2"] [data-stock]').click()
        page.locator('#supplier_id').select_option('1')
        page.locator('#purchased_on').fill('2020-01-02')
        page.locator('#expires_on').fill('2099-12-31')
        page.locator('#packs').fill('1')
        page.locator('#stock-form details summary').click()
        page.locator('#reason').fill('Compra de sabonete')
        page.get_by_role('button',name='Guardar compra').click()
        page.locator('#modal').wait_for(state='hidden')
        open_warehouse_drawer(page,2)
        page.locator('[data-product-details="2"]').click()
        page.locator('[data-lot="2"] summary').click()
        page.get_by_role('button',name='Disponibilizar lote',exact=True).click()
        page.locator('[data-lot-availability="2"][data-enabled=false]').wait_for(state='attached')
        page.locator('#modal .modal-close').click()
        page.get_by_role('button',name='Ponto de venda',exact=True).click()
        page.get_by_role('button',name='Abrir caixa',exact=True).click()
        assert_required_markers(page)
        pin=page.request.get('http://127.0.0.1:3001/api/account/pin').json()['code']
        for i,digit in enumerate(pin):page.locator('[data-pin-digit]').nth(i).fill(digit)
        page.locator('#opening').fill('5000')
        page.locator('#shift-form').get_by_role('button',name='Abrir caixa',exact=True).click()
        page.locator('#modal').wait_for(state='hidden')
        page.get_by_text('Caixa #1 aberto',exact=True).wait_for()
        page.locator('#pos-search').fill('12345')
        page.locator('#pos-search').press('Enter')
        page.locator('[data-quantity]').fill('51')
        assert 'Stock insuficiente' in page.locator('#payment-feedback').inner_text()
        assert page.get_by_role('button',name='Finalizar e emitir recibo').is_disabled()
        page.locator('[data-quantity]').fill('1.5')
        page.locator('[data-quantity]').press('Tab')
        assert_required_markers(page)
        assert not page.locator('#customer').evaluate('(el)=>el.required')
        page.locator('#customer').fill('Cliente multiproduto')
        page.locator('#discount').fill('100')
        page.get_by_role('button',name='Continuar a adicionar produtos').click()
        page.locator('[data-add]').filter(has=page.get_by_text('Sabonete',exact=True)).click()
        expect(page.locator('.cart-item')).to_have_count(2)
        assert page.locator('#customer').input_value()=='Cliente Multiproduto'
        assert page.locator('#discount').input_value()=='100'
        page.locator('.cart-item',has=page.get_by_text('Sabonete',exact=True)).get_by_role('button',name=re.compile('Remover Sabonete')).click()
        expect(page.locator('.cart-item')).to_have_count(1)
        page.locator('[data-add]').filter(has=page.get_by_text('Sabonete',exact=True)).click()
        expect(page.locator('.cart-item')).to_have_count(2)
        page.locator('#discount').fill('3000')
        assert 'desconto excede' in page.locator('#payment-feedback').inner_text()
        assert page.get_by_role('button',name='Finalizar e emitir recibo').is_disabled()
        page.locator('#discount').fill('100')
        page.locator('#paid').fill('1000')
        assert 'insuficiente' in page.locator('#payment-feedback').inner_text()
        assert '900' in page.locator('#payment-feedback').inner_text()
        assert page.locator('#sale-change').inner_text()=='—'
        assert page.get_by_role('button',name='Finalizar e emitir recibo').is_disabled()
        page.locator('#paid').fill('1899.99')
        assert '0,01' in page.locator('#payment-feedback').inner_text()
        assert page.get_by_role('button',name='Finalizar e emitir recibo').is_disabled()
        page.locator('#paid').fill('1900')
        assert 'Pagamento exato' in page.locator('#payment-feedback').inner_text()
        page.locator('#method').select_option('tpa')
        page.locator('#paid').fill('2000')
        assert 'excede' in page.locator('#payment-feedback').inner_text()
        assert page.get_by_role('button',name='Finalizar e emitir recibo').is_disabled()
        page.locator('#method').select_option('dinheiro')
        page.locator('#paid').fill('2000')
        page.get_by_role('button',name='Finalizar e emitir recibo').click()
        page.get_by_text('COMPROVATIVO INTERNO DE VENDA',exact=True).wait_for()
        assert '100' in page.locator('.receipt').inner_text()
        assert page.locator('.receipt tbody tr').count()==2
        assert 'Arroz Branco' in page.locator('.receipt').inner_text()
        assert 'Sabonete' in page.locator('.receipt').inner_text()
        assert 'TT LEBILA' in page.locator('.receipt').inner_text()
        page.screenshot(path='/tmp/loja-ui-test/recibo.png',full_page=True)
        page.get_by_role('button',name='Fechar',exact=True).last.click()
        page.get_by_role('button',name='Caixa',exact=True).click()
        assert re.sub(r'\D','',page.locator('.cash-balance-copy h2').inner_text())=='690000'
        assert page.locator('.cash-payment').count()==3
        assert page.locator('.cash-kpi').count()==4
        page.locator('#toast').evaluate("el=>el.className=''")
        page.screenshot(path='/tmp/loja-ui-test/caixa-aberto.png',full_page=True)
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        page.screenshot(path='/tmp/loja-ui-test/caixa-mobile.png',full_page=True)
        page.set_viewport_size({'width':1440,'height':1050})
        page.locator('.cash-receipt').first.click()
        page.get_by_text('COMPROVATIVO INTERNO DE VENDA',exact=True).wait_for()
        page.get_by_role('button',name='Fechar',exact=True).last.click()
        page.get_by_role('button',name='Fechar o meu caixa',exact=True).click()
        assert re.sub(r'\D','',page.locator('.cash-modal-summary strong').inner_text())=='690000'
        page.locator('#closing').fill('6800')
        assert 'insuficiente' in page.locator('#cash-feedback').inner_text()
        assert '100' in page.locator('#cash-feedback').inner_text()
        page.get_by_role('button',name='Confirmar fecho',exact=True).click()
        page.locator('#modal').wait_for(state='hidden')
        page.get_by_role('heading',name='O próximo turno começa consigo.').wait_for()
        assert 'Falta 100' in page.locator('.cash-history').inner_text()
        assert page.get_by_role('button',name='Abrir o meu caixa',exact=True).is_visible()
        page.screenshot(path='/tmp/loja-ui-test/caixa-fechado.png',full_page=True)
        page.get_by_role('button',name='Visão geral',exact=True).click()
        page.get_by_role('heading',name='Visão geral',exact=True).wait_for()
        page.screenshot(path='/tmp/loja-ui-test/dashboard.png',full_page=True)
        assert page.locator('.metric-value').first.inner_text()
        page.get_by_role('button',name='Histórico de vendas',exact=True).click()
        page.locator('.history-summary').wait_for()
        assert page.locator('#history-results tbody tr').count()==1
        assert page.locator('#scope option[value="all"]').inner_text()=='Histórico geral'
        assert page.locator('label[for="q"]').inner_text()=='Pesquisar por'
        assert page.locator('.history-search-control #q').count()==1
        assert page.locator('.history-search-control #search_by').count()==1
        assert page.locator('#search_by option').count()==3
        with page.expect_response('**/api/sales/history'):
            page.locator('#scope').select_option('mine')
        page.locator('#history-results[aria-busy="false"]').wait_for()
        assert page.locator('#history-results tbody tr').count()==1
        page.locator('#search_by').select_option('customer')
        page.locator('#q').fill('Cliente')
        with page.expect_response('**/api/sales/history'):
            page.locator('#history-form').get_by_role('button',name='Filtrar',exact=True).click()
        page.locator('#history-results[aria-busy="false"]').wait_for()
        assert page.locator('#history-results tbody tr').count()==1
        page.locator('#search_by').select_option('receipt')
        page.locator('#q').fill('não existe')
        page.get_by_text('Nenhuma venda corresponde aos filtros.',exact=True).wait_for()
        assert page.get_by_role('button',name='Exportar página CSV',exact=True).is_disabled()
        page.get_by_role('button',name='Limpar filtros',exact=True).click()
        page.locator('#history-results tbody tr').wait_for()
        assert page.locator('#scope').input_value()=='all'
        assert 'Balcão 1' in page.locator('#history-results').inner_text()
        page.screenshot(path='/tmp/loja-ui-test/historico-filtros.png',full_page=True)
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        page.set_viewport_size({'width':1440,'height':1050})

        page.get_by_role('button',name='Equipa e permissões',exact=True).click()
        page.get_by_role('button',name='Adicionar pessoa').click()
        assert_required_markers(page)
        page.locator('#name').fill('João Silva')
        page.locator('#bi').fill('009763933CA042')
        page.locator('#birth_date').fill('1995-03-15')
        page.locator('#phone').fill('923456780')
        page.locator('#email').fill('joao@gmail.com')
        page.route('**/api/users',lambda route:route.fulfill(status=502,body=''),times=1)
        page.get_by_role('button',name='Criar utilizador').click()
        page.locator('#user-form .form-error').wait_for()
        assert 'resposta incompleta' in page.locator('#user-form .form-error').inner_text()
        assert page.locator('#name').input_value()=='João Silva'
        page.get_by_role('button',name='Criar utilizador').click()
        page.locator('.credential code').wait_for()
        seller_password=page.locator('.credential code').inner_text()
        assert seller_password != initial_password
        page.get_by_role('button',name='Já guardei a palavra-passe').click()
        page.get_by_role('cell',name='João Silva 009763933CA042').wait_for()
        seller_row=page.get_by_role('row').filter(has=page.get_by_role('cell',name='João Silva 009763933CA042'))
        seller_row.get_by_role('button',name='Acesso',exact=True).click()
        assert page.locator('[data-permission]').count()==5
        assert page.locator('[data-permission="stock_edit"]').count()==0
        page.locator('[data-permission="products"]').uncheck()
        page.locator('[data-permission="dashboard"]').uncheck()
        page.get_by_role('button',name='Guardar permissões',exact=True).click()
        page.locator('#modal').wait_for(state='hidden')
        # Separate session: seller sees POS availability, no stock page or internal controls.
        seller_context=browser.new_context(viewport={'width':1440,'height':1050})
        seller_page=seller_context.new_page()
        seller_page.goto('http://127.0.0.1:3001')
        seller_page.locator('#identifier').fill('joao@gmail.com')
        seller_page.locator('#password').fill(seller_password)
        seller_page.get_by_role('button',name='Iniciar sessão',exact=True).click()
        seller_page.get_by_role('heading',name='Crie uma nova palavra-passe',exact=True).wait_for()
        seller_page.locator('#password').fill('PrimeiroVendedor123!')
        seller_page.locator('#confirmation').fill('PrimeiroVendedor123!')
        seller_page.get_by_role('button',name='Guardar e entrar na loja').click()
        seller_page.get_by_role('heading',name='Ponto de venda',exact=True).wait_for()
        for label in ['Armazém','Equipa e permissões','Atividades','Visão geral']:
            assert seller_page.get_by_role('button',name=label,exact=True).count()==0
        assert seller_page.locator('[data-stock],[data-product]').count()==0
        assert seller_page.locator('[data-add]').count()==2

        seller_page.get_by_role('button',name='Histórico de vendas',exact=True).click()
        seller_page.get_by_text('Nenhuma venda corresponde aos filtros.',exact=True).wait_for()
        assert seller_page.locator('#scope').count()==0
        assert seller_page.locator('[data-receipt]').count()==0
        assert 'Acesso limitado às vendas dos seus caixas.' in seller_page.locator('#history-form').inner_text()
        seller_context.close()

        page.locator('#filter-users-0-q').fill('ninguém')
        page.get_by_text('Nenhum registo corresponde aos filtros.',exact=True).wait_for()
        page.locator('#filter-users-0-q').fill('João Silva')
        assert page.locator('tbody tr:visible').count()==1
        page.locator('#filter-users-0-q').fill('')
        page.get_by_role('button',name='Adicionar pessoa').click()
        page.locator('#name').fill('Maria Silva')
        page.locator('#bi').fill('10976393CA042')
        assert not page.locator('#bi').evaluate('(el)=>el.checkValidity()')
        page.locator('#bi').fill('009763934ca042')
        assert page.locator('#bi').input_value()=='009763934CA042'
        page.locator('#birth_date').fill('1990-01-01')
        page.locator('#phone').fill('+351931485150')
        page.locator('#email').fill('maria@gmail.com')
        page.locator('#role').select_option('gerente')
        page.get_by_role('button',name='Criar utilizador').click()
        page.locator('.credential code').wait_for()
        page.get_by_role('button',name='Já guardei a palavra-passe').click()
        manager_row=page.get_by_role('row').filter(has=page.get_by_role('cell',name='Maria Silva 009763934CA042'))
        manager_row.get_by_role('button',name='Acesso',exact=True).click()
        assert page.locator('[data-permission]').count()==18
        page.locator('[data-permission="stock_edit"]').uncheck()
        page.locator('[data-permission="activity"]').uncheck()
        page.get_by_role('button',name='Guardar permissões',exact=True).click()
        page.locator('#modal').wait_for(state='hidden')
        page.get_by_role('button',name='Adicionar pessoa').click()
        assert page.locator('#role option').count()==4
        page.locator('#modal [data-action="close"]').last.click()
        page.get_by_role('button',name='A minha conta',exact=True).click()
        assert page.locator('#app #name').count()==0
        page.get_by_role('button',name='Recuperar acesso',exact=True).click()
        page.get_by_role('heading',name='Recuperar a sua palavra-passe').wait_for()
        assert 'Não é possível mostrar a palavra-passe atual' in page.locator('#modal').inner_text()
        page.get_by_role('button',name='Voltar à conta',exact=True).click()
        page.locator('#current_password').fill(initial_password)
        page.locator('#password').fill('abcdefgh')
        assert not page.locator('#password').evaluate('(el)=>el.checkValidity()')
        page.locator('#password').fill('NovaSenhaTemporaria123!')
        page.locator('#confirmation').fill('NovaSenhaTemporaria123!')
        page.get_by_role('button',name='Alterar palavra-passe',exact=True).click()
        page.get_by_text('Palavra-passe alterada. Outras sessões foram terminadas.',exact=True).wait_for()
        page.get_by_role('button',name='Armazém',exact=True).click()
        page.get_by_role('button',name='Histórico de entradas e saídas',exact=True).click()
        page.get_by_role('heading',name='Histórico de entradas e saídas',exact=True).wait_for()
        assert page.url.endswith('#/armazem/historico')
        assert page.locator('.warehouse-catalog').count()==0
        expect(page.get_by_role('navigation',name='Caminho')).to_contain_text('Armazém')
        page.reload()
        page.get_by_role('heading',name='Histórico de entradas e saídas',exact=True).wait_for()
        page.locator('#warehouse-movements tbody tr').first.wait_for()
        assert 'Compra Inicial' in page.locator('#warehouse-movements').inner_text()
        page.screenshot(path='/tmp/loja-ui-test/armazem-historico.png',full_page=True)
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'warehouse history mobile overflow'
        page.set_viewport_size({'width':1440,'height':1050})
        assert page.get_by_role('button',name='Filtrar movimentos',exact=True).count()==0
        assert page.locator('label[for="movement_q"]').count()==0
        assert page.locator('#movement_q').get_attribute('placeholder')=='Pesquisar…'
        def movement_filter(action):
            with page.expect_response(lambda r: '/api/warehouse/history' in r.url) as response:
                action()
            data=response.value.json()
            assert response.value.status==200, data
            expect(page.locator('#warehouse-movements')).to_have_attribute('aria-busy','false')
            expect(page.locator('#warehouse-movements>.help')).to_contain_text(str(data['count'])+' movimentos')
            assert page.locator('#warehouse-movements tbody tr').count()==len(data['movements'])
            return data
        clear_movements=lambda:movement_filter(lambda:page.get_by_role('button',name='Limpar filtros',exact=True).click())
        all_movements=clear_movements()
        assert all_movements['count']>0
        searched=movement_filter(lambda:page.locator('#movement_q').fill('Compra Inicial'))
        assert searched['count']>0 and all('Compra Inicial' in m['reason'] for m in searched['movements'])
        assert movement_filter(lambda:page.locator('#movement_q').fill('sem_resultados_xyz'))['count']==0
        expect(page.locator('#warehouse-movements')).to_contain_text('Nenhum movimento corresponde')
        clear_movements()
        product=movement_filter(lambda:page.locator('#movement_product').select_option('1'))
        assert product['count']>0 and all(m['product_id']==1 for m in product['movements'])
        clear_movements()
        sales=movement_filter(lambda:page.locator('#movement_kind').select_option('venda'))
        assert sales['count']>0 and all(m['kind']=='venda' for m in sales['movements'])
        outgoing=movement_filter(lambda:page.locator('#movement_direction').select_option('saida'))
        assert outgoing['count']>0 and all(m['quantity']<0 for m in outgoing['movements'])
        assert movement_filter(lambda:page.locator('#movement_direction').select_option('entrada'))['count']==0
        clear_movements()
        incoming=movement_filter(lambda:page.locator('#movement_direction').select_option('entrada'))
        assert incoming['count']>0 and all(m['quantity']>0 for m in incoming['movements'])
        clear_movements()
        assert movement_filter(lambda:page.locator('#movement_start').fill('2099-01-01'))['count']==0
        clear_movements()
        assert movement_filter(lambda:page.locator('#movement_end').fill('1900-01-01'))['count']==0
        clear_movements()
        today=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=1)).date().isoformat()
        dated=movement_filter(lambda:page.locator('#movement_start').fill(today))
        dated=movement_filter(lambda:page.locator('#movement_end').fill(today))
        assert dated['count']>0
        assert all((datetime.datetime.fromisoformat(m['created']).replace(tzinfo=datetime.timezone.utc)+datetime.timedelta(hours=1)).date().isoformat()==today for m in dated['movements'])
        clear_movements()
        # Exercise both pagination buttons; API pagination itself is covered by warehouse.test.js.
        def paginated_history(route):
            number=route.request.post_data_json['page']
            route.fulfill(content_type='application/json',body=json.dumps({**all_movements,'count':51,'pages':2,'page':number}))
        page.route('**/api/warehouse/history',paginated_history)
        clear_movements()
        assert movement_filter(lambda:page.locator('[data-warehouse-page="2"]').click())['page']==2
        assert movement_filter(lambda:page.locator('[data-warehouse-page="1"]').click())['page']==1
        page.unroute('**/api/warehouse/history',paginated_history)
        clear_movements()
        movement_filter(lambda:page.locator('#movement_kind').select_option('venda'))
        movement_filter(lambda:page.locator('#movement_direction').select_option('saida'))
        page.screenshot(path='/tmp/loja-ui-test/armazem-historico-filtros.png',full_page=True)
        page.get_by_role('navigation',name='Caminho').get_by_role('button',name='Armazém',exact=True).click()
        page.locator('.warehouse-catalog').wait_for()
        assert page.url.endswith('#/armazem')
        page.go_back()
        page.get_by_role('heading',name='Histórico de entradas e saídas',exact=True).wait_for()
        assert page.locator('#movement_kind').input_value()=='venda'
        assert page.locator('#movement_direction').input_value()=='saida'
        page.get_by_role('button',name='Limpar filtros',exact=True).click()
        page.get_by_role('button',name='Terminar sessão',exact=True).click()
        page.locator('#identifier').fill('009763932CA042')
        page.locator('#password').fill('NovaSenhaTemporaria123!')
        page.get_by_role('button',name='Iniciar sessão').click()
        page.get_by_role('heading',name='Visão geral',exact=True).wait_for()
        page.get_by_role('button',name='Terminar sessão',exact=True).click()
        page.get_by_role('button',name='Esqueci a palavra-passe',exact=True).click()
        page.get_by_text('O envio de email e SMS ainda não foi ativado pelo proprietário. Peça-lhe a reposição da sua palavra-passe.',exact=True).wait_for()
        assert page.get_by_role('button',name='Enviar código').is_disabled()
        page.get_by_role('button',name='Voltar ao login',exact=True).click()
        # Simulated delivery tests only the recovery UI; OTP integrity is tested separately.
        page.route('**/api/recovery/options',lambda route:route.fulfill(content_type='application/json',body=json.dumps({'email':True,'sms':True})))
        page.route('**/api/recovery/request',lambda route:route.fulfill(content_type='application/json',body=json.dumps({'challenge':'test-challenge','expires_in':120,'message':'Código de teste enviado pelo transporte simulado.'})))
        db=sqlite3.connect(folder+'/loja.sqlite')
        db.execute('INSERT INTO sessions(token,user_id,expires,recovery) VALUES(?,?,?,1)',('e'*64,1,int(time.time()*1000)+600000))
        db.commit();db.close()
        page.route('**/api/recovery/verify',lambda route:route.fulfill(content_type='application/json',headers={'Set-Cookie':'session='+('e'*64)+'; HttpOnly; SameSite=Strict; Path=/'},body=json.dumps({'ok':True,'reset_required':True})))
        page.get_by_role('button',name='Esqueci a palavra-passe',exact=True).click()
        page.locator('#recover-form button[type="submit"]:enabled').wait_for()
        page.locator('#identifier').fill('ana@gmail.com')
        page.get_by_role('button',name='Enviar código').click()
        page.locator('#countdown').wait_for()
        page.locator('#code').fill('123456')
        page.get_by_role('button',name='Entrar com código',exact=True).click()
        page.get_by_role('heading',name='Crie uma nova palavra-passe').wait_for()
        page.locator('#password').fill('Ab12!xyz')
        page.locator('#confirmation').fill('Ab12!xyz')
        page.get_by_role('button',name='Guardar e entrar na loja').click()
        page.get_by_role('heading',name='Visão geral',exact=True).wait_for()
        page.get_by_role('button',name='Terminar sessão',exact=True).click()
        page.locator('#identifier').fill('ana@gmail.com')
        page.locator('#password').fill('Ab12!xyz')
        page.get_by_role('button',name='Iniciar sessão').click()
        page.get_by_role('heading',name='Visão geral',exact=True).wait_for()
        # Fiscal rates are test fixtures only, not legal recommendations.
        page.get_by_role('navigation').get_by_role('button',name='IVA e regras fiscais',exact=True).click()
        page.get_by_role('button',name='Nova regra',exact=True).click()
        page.locator('#name').fill('Regra fictícia de teste')
        assert_required_markers(page)
        assert page.locator('#legal_basis').evaluate('(el)=>el.required')
        page.locator('#rate').fill('14')
        page.locator('#legal_basis').fill('TESTE DE CÁLCULO, sem validade legal')
        page.get_by_role('button',name='Guardar regra',exact=True).click()
        page.locator('#modal').wait_for(state='hidden')
        page.get_by_role('button',name='Nova regra',exact=True).click()
        page.locator('#name').fill('Isenção fictícia de teste')
        page.locator('#kind').select_option('isento')
        assert page.locator('#rate').input_value()=='0'
        page.locator('#legal_basis').fill('TESTE DE CÁLCULO, sem validade legal')
        page.get_by_role('button',name='Guardar regra',exact=True).click()
        page.locator('#modal').wait_for(state='hidden')
        page.locator('#regime').select_option('geral')
        assert not page.locator('#company_nif').evaluate('(el)=>el.required')
        page.locator('#enabled').select_option('true')
        assert page.locator('#company_nif').evaluate('(el)=>el.required')
        assert_required_markers(page)
        page.locator('#price_mode').select_option('excluded')
        page.locator('#company_nif').fill('5000000000')
        page.locator('#company_address').fill('Morada fictícia de teste')
        page.locator('#settings_legal_basis').fill('TESTE DE CÁLCULO, sem validade legal')
        page.locator('input[name="confirmed"]').check()
        page.get_by_role('button',name='Guardar enquadramento',exact=True).click()
        page.get_by_text('Regras introduzidas e ativadas pelo proprietário',exact=True).wait_for()
        page.locator('#tax_rule_id').select_option('1')
        page.locator('.tax-product-option',has=page.get_by_text('Arroz Branco',exact=True)).get_by_role('checkbox').check()
        page.get_by_role('button',name='Aplicar aos produtos selecionados',exact=True).click()
        page.locator('.tax-product-option',has=page.get_by_text('Arroz Branco',exact=True)).locator('small',has_text='14%').wait_for()
        page.locator('#tax_rule_id').select_option('2')
        page.locator('.tax-product-option',has=page.get_by_text('Sabonete',exact=True)).get_by_role('checkbox').check()
        page.get_by_role('button',name='Aplicar aos produtos selecionados',exact=True).click()
        page.locator('.tax-product-option',has=page.get_by_text('Sabonete',exact=True)).locator('small',has_text='Isento').wait_for()
        page.get_by_role('button',name='Ponto de venda',exact=True).click()
        page.get_by_role('button',name='Abrir caixa',exact=True).click()
        pin=page.request.get('http://127.0.0.1:3001/api/account/pin').json()['code']
        for i,digit in enumerate(pin):page.locator('[data-pin-digit]').nth(i).fill(digit)
        page.locator('#opening').fill('0')
        page.locator('#shift-form').get_by_role('button',name='Abrir caixa',exact=True).click()
        page.locator('#modal').wait_for(state='hidden')
        page.get_by_text('Caixa #2 aberto',exact=True).wait_for()
        page.locator('[data-add]',has=page.get_by_text('Arroz Branco',exact=True)).click()
        page.locator('[data-add]',has=page.get_by_text('Sabonete',exact=True)).click()
        expect(page.locator('.cart-item')).to_have_count(2)
        expect(page.locator('#tax-total')).to_contain_text('140')
        page.locator('#paid').fill('2000')
        expect(page.locator('#sale-change')).to_contain_text('360')
        page.get_by_role('button',name='Finalizar e emitir recibo').click()
        page.get_by_role('heading',name='Discriminação de IVA',exact=True).wait_for()
        assert '140' in page.locator('.receipt').inner_text()
        assert page.locator('.receipt tbody').first.locator('tr').count()==2
        page.screenshot(path='/tmp/loja-ui-test/iva-recibo.png',full_page=True)
        page.get_by_role('button',name='Fechar',exact=True).last.click()
        assert page.request.get('http://127.0.0.1:3001/api/sales/1').json()['fiscal_state']=='pending'
        page.get_by_role('navigation').get_by_role('button',name='IVA e regras fiscais',exact=True).click()
        page.get_by_role('button',name='Consultar período',exact=True).click()
        page.locator('#tax-report-result .metrics').wait_for()
        assert '140' in page.locator('#tax-report-result').inner_text()
        page.screenshot(path='/tmp/loja-ui-test/iva-config.png',full_page=True)
        # New operations panels: personal PIN, physical registers, partners, warehouse and cancellation.
        page.get_by_role('button',name='A minha conta',exact=True).click()
        page.locator('.pin-display span').first.wait_for()
        assert page.locator('.pin-display span').count()==4
        page.get_by_role('button',name='Consultar códigos da equipa',exact=True).click()
        page.get_by_role('heading',name='Códigos pessoais da equipa',exact=True).wait_for()
        page.locator('#modal [data-action="close"]').first.click()
        page.get_by_role('button',name='Caixa',exact=True).click()
        page.get_by_role('button',name='Definir balcões',exact=True).click()
        page.locator('#count').fill('2')
        page.get_by_role('button',name='Guardar balcões',exact=True).click()
        page.locator('.register-tile').nth(1).wait_for()
        assert page.locator('.register-tile.occupied').count()==1
        assert page.locator('.register-tile.available').count()==1
        page.screenshot(path='/tmp/loja-ui-test/balcoes.png',full_page=True)
        page.get_by_role('button',name='Parceiros',exact=True).click()
        page.locator('#partners-results tbody tr').wait_for()
        assert 'compras@fornecedor.ao' in page.locator('#partners-results').inner_text()
        page.get_by_role('button',name='Adicionar parceiro',exact=True).click()
        page.locator('#partner_name').fill('Parceiro Logístico')
        page.locator('#partner_type').select_option('outro')
        page.locator('#partner_phone').fill('923456789')
        page.locator('#partner_email').fill('contacto@parceiro.ao')
        page.locator('#partner_location').fill('Luanda')
        page.get_by_role('button',name='Guardar parceiro',exact=True).click()
        page.locator('#partners-results tbody tr').nth(1).wait_for()
        page.locator('#partner_kind').select_option('fornecedor')
        assert page.locator('#partners-results tbody tr').count()==1
        page.get_by_role('button',name='Adicionar parceiro',exact=True).click()
        page.locator('#partner_name').fill('Fornecedor Apenas Local')
        page.locator('#partner_location').fill('Benguela')
        assert page.locator('#partner_phone').input_value()==''
        assert page.locator('#partner_email').input_value()==''
        page.get_by_role('button',name='Guardar parceiro',exact=True).click()
        page.locator('#modal').wait_for(state='hidden')
        page.locator('#partners-results').get_by_text('Fornecedor Apenas Local',exact=True).wait_for()
        page.get_by_role('button',name='Armazém',exact=True).click()
        assert page.locator('.warehouse-catalog table').count()==1
        assert page.locator('.warehouse-stock-table thead th').all_inner_texts()==['Nome','Categoria','Indisponível','Disponível','Estado','Stock total']
        assert page.locator('.warehouse-stock-table th').first.evaluate('el=>getComputedStyle(el).backgroundColor')=='rgb(25, 103, 201)'
        assert page.locator('[data-catalog-product="1"]').bounding_box()['height']<page.locator('.warehouse-stock-table thead').bounding_box()['height']
        total_box=page.locator('[data-catalog-product="1"] .quantity-total strong').bounding_box()
        table_box=page.locator('.warehouse-stock-table').bounding_box()
        assert table_box['x']+table_box['width']-total_box['x']-total_box['width']>=30
        assert page.locator('.sidebar .brand-mark').bounding_box()['width']>=60
        assert page.locator('.sidebar .tt-symbol').evaluate('el=>parseFloat(getComputedStyle(el).fontSize)')>=34
        # Row/cell click and keyboard both toggle one drawer, with actions beneath the row.
        page.locator('[data-catalog-product="1"]').click()
        expect(page.locator('[data-product-drawer="1"]')).to_have_attribute('aria-hidden','false')
        expect(page.locator('[data-product-drawer="1"] [data-stock]')).to_be_visible()
        expect(page.locator('[data-product-drawer="1"] [data-product-details]')).to_have_text('Disponibilizar')
        row_box=page.locator('[data-catalog-product="1"]').bounding_box()
        action_box=page.locator('[data-product-drawer="1"] [data-stock]').bounding_box()
        assert action_box['y']>=row_box['y']+row_box['height']-1
        page.locator('[data-catalog-product="2"]').click()
        expect(page.locator('[data-product-drawer="1"]')).to_have_attribute('aria-hidden','true')
        expect(page.locator('[data-product-drawer="2"]')).to_have_attribute('aria-hidden','false')
        page.locator('[data-catalog-product="2"] button').press('Enter')
        expect(page.locator('[data-product-drawer="2"]')).to_have_attribute('aria-hidden','true')
        expect(page.locator('[data-product-drawer="2"] [data-stock]')).not_to_be_visible()
        assert page.locator('[data-catalog-product="1"] .quantity-unavailable strong').inner_text()=='0 kg'

        assert page.locator('#app [data-lot]').count()==0
        assert page.locator('#app [data-sale-availability]').count()==0
        assert page.locator('#app [data-stock]').count()==2
        assert page.locator('#warehouse-history').count()==0
        page.locator('#toast').evaluate("el=>el.className=''")
        page.screenshot(path='/tmp/loja-ui-test/armazem.png',full_page=True)
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'warehouse mobile horizontal overflow'
        assert page.locator('[data-catalog-product="1"]').bounding_box()['height']<page.locator('.warehouse-stock-table thead').bounding_box()['height']
        page.screenshot(path='/tmp/loja-ui-test/armazem-mobile.png',full_page=True)
        open_warehouse_drawer(page,1)
        mobile_action=page.locator('[data-product-drawer="1"] [data-product-details]')
        expect(mobile_action).to_be_visible()
        mobile_box=mobile_action.bounding_box()
        assert mobile_box['x']>=0 and mobile_box['x']+mobile_box['width']<=390, mobile_box
        page.screenshot(path='/tmp/loja-ui-test/armazem-gaveta-mobile.png',full_page=True)
        page.locator('[data-catalog-product="1"] button').press('Enter')
        page.set_viewport_size({'width':1440,'height':1050})
        assert page.locator('.nav [data-page=products]').count()==0
        product_id='1'
        open_warehouse_drawer(page,1)
        page.locator('[data-product-details="1"]').click()
        page.locator('[data-lot="1"] summary').click()
        page.screenshot(path='/tmp/loja-ui-test/armazem-detalhes.png',full_page=True)
        page.get_by_role('button',name='Retirar da venda',exact=True).click()
        page.locator('[data-lot-availability="1"][data-enabled=true]').wait_for(state='attached')
        page.locator('#modal .modal-close').click()
        page.get_by_role('button',name='Ponto de venda',exact=True).click()
        assert page.locator('[data-add="1"]').count()==0
        page.get_by_role('button',name='Armazém',exact=True).click()
        open_warehouse_drawer(page,1)
        page.locator('[data-product-details="1"]').click()
        page.locator('[data-lot="1"] summary').click()
        page.get_by_role('button',name='Disponibilizar lote',exact=True).click()
        page.locator('[data-lot-availability="1"][data-enabled=false]').wait_for(state='attached')
        page.locator('#modal .modal-close').click()
        page.get_by_role('button',name='Ponto de venda',exact=True).click()
        assert page.locator('[data-add="1"]').count()==1
        page.get_by_role('button',name='Armazém',exact=True).click()
        # Lower warehouse worker gets entry/expiry tools, never the fixed catalogue or partner contacts.
        worker=page.request.post('http://127.0.0.1:3001/api/users',data={'name':'Pessoa Armazém','bi':'009763935CA042','birth_date':'1990-01-01','email':'warehouse@gmail.com','role':'armazem'}).json()
        wc=browser.new_context(viewport={'width':1440,'height':1050});wp=wc.new_page()
        wp.goto('http://127.0.0.1:3001')
        wp.locator('#identifier').fill('warehouse@gmail.com');wp.locator('#password').fill(worker['password'])
        wp.get_by_role('button',name='Iniciar sessão',exact=True).click()
        wp.get_by_role('heading',name='Crie uma nova palavra-passe',exact=True).wait_for()
        wp.locator('#password').fill('SenhaArmazem123!');wp.locator('#confirmation').fill('SenhaArmazem123!')
        wp.get_by_role('button',name='Guardar e entrar na loja').click()
        wp.get_by_role('heading',name='Armazém',exact=True).wait_for()
        assert wp.get_by_role('button',name='Adicionar produto',exact=True).count()==0
        assert wp.get_by_role('button',name='Parceiros',exact=True).count()==0
        wp.get_by_role('button',name='Armazém',exact=True).click()
        open_warehouse_drawer(wp,1)
        wp.locator('[data-product-details="1"]').click()
        wp.locator('[data-lot="1"] summary').click()
        assert wp.get_by_role('button',name='Registar saída',exact=True).count()==1
        wp.locator('[data-dispose-lot]').first.click()
        wp.locator('#quantity').fill('0.1');wp.locator('#reason').fill('Embalagem danificada')
        wp.get_by_role('button',name='Confirmar saída',exact=True).click()
        wp.get_by_role('button',name='Histórico de entradas e saídas',exact=True).click()
        wp.get_by_text('Embalagem Danificada',exact=True).wait_for()
        wc.close()
        before_purchase=page.request.get('http://127.0.0.1:3001/api/state').json()['products'][0]['stock']
        open_warehouse_drawer(page,1)
        page.locator('[data-product-drawer="1"] [data-stock]').click()
        page.locator('#packs').fill('1')
        page.locator('#supplier_id').select_option('1')
        page.locator('#expires_on').fill('2099-12-31')
        page.get_by_role('button',name='Guardar compra',exact=True).click()
        page.locator('#modal').wait_for(state='hidden')
        after_purchase=page.request.get('http://127.0.0.1:3001/api/state').json()['products'][0]['stock']
        assert after_purchase==before_purchase, 'new purchase was automatically released'
        assert page.locator('[data-catalog-product="1"] .quantity-unavailable strong').inner_text()=='25 kg'
        open_warehouse_drawer(page,1)
        page.locator('[data-product-details="1"]').click()
        expect(page.locator('#modal [data-lot]')).to_have_count(2)
        page.locator('#modal [data-lot]').last.locator('summary').click()
        assert page.get_by_role('button',name='Disponibilizar lote',exact=True).is_visible()
        assert page.locator('#modal [data-stock]').count()==0, 'purchase action must only exist on global stock'
        page.locator('#modal .modal-close').click()
        # Set the minimum between the old released stock and the total after release.
        open_warehouse_drawer(page,1)
        page.locator('[data-product-details="1"]').click()
        page.get_by_text('Dados do produto',exact=True).click()
        page.get_by_role('button',name='Editar produto',exact=True).click()
        page.locator('#product-extra summary').click()
        page.locator('#minimum').fill(str(round(before_purchase+1,3)))
        page.get_by_role('button',name='Guardar produto',exact=True).click()
        page.locator('#modal').wait_for(state='hidden')
        stock_row=page.locator('[data-catalog-product="1"]')
        expect(stock_row.locator('.quantity-available')).to_have_class(re.compile('is-low'))
        assert stock_row.locator('[data-expiry-state]').count()==1
        assert stock_row.locator('.minimum-alert').count()==0
        assert stock_row.locator('.warehouse-product-name [data-expiry-state]').count()==0
        amount_box=stock_row.locator('.quantity-available strong').bounding_box()
        icon_box=stock_row.locator('.expiry-indicator').bounding_box()
        assert icon_box['x']>=amount_box['x']+amount_box['width'] and abs(icon_box['y']+icon_box['height']/2-amount_box['y']-amount_box['height']/2)<4
        assert page.locator('[data-product-drawer="1"] [data-product-details]').evaluate("el=>getComputedStyle(el).backgroundColor")=='rgb(22, 116, 73)'
        assert stock_row.locator('.quantity-total strong').evaluate("el=>getComputedStyle(el).color")=='rgb(25, 93, 184)'
        assert stock_row.locator('.quantity-available strong').evaluate("el=>getComputedStyle(el).color")=='rgb(180, 35, 50)'
        assert stock_row.locator('.warehouse-row-toggle').evaluate("el=>parseFloat(getComputedStyle(el).fontSize)")>=18
        open_warehouse_drawer(page,1)
        page.locator('[data-product-details="1"]').click()
        page.locator('[data-lot="3"] summary').click()
        page.get_by_role('button',name='Disponibilizar lote',exact=True).click()
        page.locator('[data-lot-availability="3"][data-enabled=false]').wait_for(state='attached')
        page.locator('#modal .modal-close').click()
        stock_row=page.locator('[data-catalog-product="1"]')
        expect(stock_row.locator('.quantity-available')).not_to_have_class(re.compile('is-low'))
        assert stock_row.locator('.quantity-available strong').evaluate("el=>getComputedStyle(el).color")=='rgb(22, 116, 73)'
        # Two lots: oldest is checked/focused; choosing the newer one produces its own cart line.
        page.get_by_role('button',name='Ponto de venda',exact=True).click()
        page.locator('[data-add="1"]').click()
        page.locator('#lot-choice-form').wait_for()
        picker_box=page.locator('#modal').bounding_box()
        assert picker_box['width']<=370 and picker_box['height']<=360, picker_box
        assert page.locator('#modal').evaluate("el=>el.classList.contains('modal-compact')")
        assert page.locator('#lot-choice-form .expiry-badge').count()==0
        expect(page.locator('#lot-choice-form input[value="1"]')).to_be_checked()
        assert page.locator('#lot-choice-form input[value="1"]').evaluate('el=>el===document.activeElement')
        assert 'Mais antigo · Sugerido' in page.locator('#lot-choice-form').inner_text()
        assert_required_markers(page)
        page.screenshot(path='/tmp/loja-ui-test/escolher-lote.png',full_page=True)
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'lot selector mobile overflow'
        page.set_viewport_size({'width':1440,'height':1050})
        page.get_by_role('button',name='Adicionar lote selecionado',exact=True).click()
        page.locator('[data-cart-line="1-1"]').wait_for()
        page.locator('[data-add="1"]').click()
        page.locator('#lot-choice-form input[value="3"]').check()
        page.get_by_role('button',name='Adicionar lote selecionado',exact=True).click()
        page.locator('[data-cart-line="1-3"]').wait_for()
        page.locator('[data-cart-line="1-1"] [data-quantity]').fill('1.5')
        page.locator('[data-cart-line="1-3"] [data-quantity]').fill('0.5')
        page.locator('#method').select_option('tpa')
        page.locator('#sale-form .checkout').click()
        page.locator('.receipt').wait_for()
        latest=page.request.post('http://127.0.0.1:3001/api/sales/history',data={'scope':'mine'}).json()['sales'][0]
        selected_receipt=page.request.get('http://127.0.0.1:3001/api/sales/'+str(latest['id'])).json()
        assert len(selected_receipt['items'])==2
        assert {i['lots'][0]['lot_id'] for i in selected_receipt['items']}=={1,3}
        assert {i['lots'][0]['lot_id']:i['quantity'] for i in selected_receipt['items']}=={1:1.5,3:0.5}
        page.locator('#modal .modal-close').click()
        page.get_by_role('button',name='Armazém',exact=True).click()
        # Transition a released lot through green, orange and red, with another valid lot still available.
        day=datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=1))).date()
        def correct_expiry(value):
            open_warehouse_drawer(page,1)
            page.locator('[data-product-details="1"]').click()
            page.locator('[data-lot="1"] summary').click()
            page.locator('[data-lot-edit="1"]').click()
            page.locator('#expires_on').fill(value)
            page.get_by_role('button',name='Guardar correção',exact=True).click()
            page.locator('#modal').wait_for(state='hidden')
        correct_expiry((day+datetime.timedelta(days=1)).isoformat())
        expect(page.locator('[data-catalog-product="1"] [data-expiry-state]')).to_have_attribute('data-expiry-state','warning')
        assert page.locator('[data-catalog-product="1"] .expiry-indicator svg').evaluate("el=>getComputedStyle(el).color")=='rgb(166, 83, 6)'
        open_warehouse_drawer(page,1)
        page.locator('[data-product-details="1"]').click()
        expect(page.locator('[data-lot="1"]')).to_have_class(re.compile('lot-warning'))
        expect(page.locator('[data-lot="3"]')).to_have_class(re.compile('lot-healthy'))
        page.locator('#modal .modal-close').click()
        correct_expiry((day-datetime.timedelta(days=1)).isoformat())
        expect(page.locator('[data-catalog-product="1"] [data-expiry-state]')).to_have_attribute('data-expiry-state','expired')
        assert page.locator('[data-catalog-product="1"] .expiry-indicator svg').evaluate("el=>getComputedStyle(el).color")=='rgb(180, 35, 50)'
        open_warehouse_drawer(page,1)
        page.locator('[data-product-details="1"]').click()
        expect(page.locator('[data-lot="1"]')).to_have_class(re.compile('lot-expired'))
        page.screenshot(path='/tmp/loja-ui-test/alarme-lote-expirado.png',full_page=True)
        page.locator('#modal .modal-close').click()
        correct_expiry('2099-12-31')
        expect(page.locator('[data-catalog-product="1"] [data-expiry-state]')).to_have_attribute('data-expiry-state','healthy')
        assert page.locator('[data-catalog-product="1"] .expiry-indicator svg').evaluate("el=>getComputedStyle(el).color")=='rgb(22, 116, 73)'
        page.locator('#toast').evaluate("el=>el.className=''")
        page.screenshot(path='/tmp/loja-ui-test/armazem-alarmes.png',full_page=True)
        open_warehouse_drawer(page,1)
        page.locator('[data-product-details="1"]').click()
        page.locator('[data-lot="1"] summary').click()
        page.get_by_role('button',name='Registar devolução',exact=True).click()
        assert_required_markers(page)
        assert not page.locator('#return-form').evaluate('(el)=>el.checkValidity()')
        page.locator('#reason').fill('Cliente devolveu os produtos')
        page.get_by_role('button',name='Confirmar devolução',exact=True).click()
        page.locator('#modal').wait_for(state='hidden')
        page.get_by_role('button',name='Histórico de vendas',exact=True).click()
        page.locator('#history-results').get_by_text('Cancelada',exact=True).wait_for()
        current_lots=page.request.get('http://127.0.0.1:3001/api/warehouse/products/1').json()['lots']
        exhausted=next(l for l in current_lots if l['id']==3)
        outgoing=page.request.post('http://127.0.0.1:3001/api/warehouse/dispose',data={'lot_id':3,'quantity':exhausted['quantity'],'kind':'outra_saida','reason':'Saída para validar lote esgotado'})
        assert outgoing.status==200
        assert next(l for l in page.request.get('http://127.0.0.1:3001/api/warehouse/products/1').json()['lots'] if l['id']==3)['remaining']==0
        # Enough separate purchases to verify scrolling on a long details window too.
        for _ in range(9):
            purchase=page.request.post('http://127.0.0.1:3001/api/stock',data={'product_id':1,'supplier_id':1,'purchased_on':day.isoformat(),'expires_on':'2099-12-31','packs':1})
            assert purchase.status==200
        page.get_by_role('button',name='Armazém',exact=True).click()
        open_warehouse_drawer(page,1)
        page.locator('[data-product-details="1"]').click()
        page.locator('#modal .warehouse-lots').wait_for()
        assert page.locator('#modal [data-lot="3"]').count()==0
        assert 'Esgotado' not in page.locator('#modal').inner_text()
        assert not page.locator('#modal').evaluate("el=>el.classList.contains('modal-compact')")
        header_position=page.locator('#modal .modal-head').bounding_box()['y']
        page.locator('#modal .modal-body').evaluate('el=>el.scrollTop=el.scrollHeight')
        assert page.locator('#modal .modal-body').evaluate('el=>el.scrollTop')>0
        assert abs(page.locator('#modal .modal-head').bounding_box()['y']-header_position)<1
        assert page.locator('#modal').evaluate('el=>el.scrollTop')==0
        page.screenshot(path='/tmp/loja-ui-test/detalhes-cabecalho-fixo.png',full_page=True)
        page.locator('#modal .modal-close').click()
        page.get_by_role('button',name='Visão geral',exact=True).click()
        page.locator('#toast').evaluate("el=>el.className=''")
        page.screenshot(path='/tmp/loja-ui-test/tt-dashboard.png',full_page=True)
        page.set_viewport_size({'width':390,'height':844})
        page.get_by_role('button',name='Visão geral',exact=True).click()
        page.screenshot(path='/tmp/loja-ui-test/mobile.png',full_page=True)
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'mobile horizontal overflow'
        assert not errors, errors
        browser.close()
        print('PASS: zero numeric defaults, required free-text packaging with suggestions, supplier required name/location only in order, blue header and shorter body rows, stronger TT branding, six-column stock table, row drawers by mouse and keyboard with one open at a time, unavailable quantity, green availability action beneath rows, compact lot picker, depleted lots hidden with history preserved, single expiry icon beside available stock, green details button, fixed headers with body-only scrolling on forms and details, warehouse history route/breadcrumb/reload/back with saved filters, green/orange/red expiry alarms, blue total and green/red available stock, real two-lot selection with FIFO suggestion, larger type, simplified global warehouse, required purchase/expiry dates, new lots pending even on released products, on-demand product details, per-lot availability controls, warehouse movement filters, warehouse desktop/mobile layout, outside-click and Escape preserve modal forms, blue modal headers and red close button, physical registers, private PIN panel, supplier creation, partner filters, lower warehouse access and disposal, immutable cancellation UI, own-cash seller history, leadership history filters and mobile layout, custom manager permissions, seller menus in separate session, seller/manager registration, unique leadership UI, incomplete-response handling, live validation, grouped numbers, password visibility/strength, filters, simulated recovery UI, real password reset, multi-product receipt, underpayment down to one cent, electronic excess, cash shortage, pending VAT, rule configuration, product classification, mixed VAT receipt, tax report, required markers and conditional requirements, centered blue registration/login and desktop/mobile layout; no JavaScript errors.')
except Exception:
    try:
        print('Browser flow failed; no credentials logged.')
        print(errors)
    except: pass
    raise
finally:
    proc.terminate();proc.wait(timeout=5)
    shutil.rmtree(folder)

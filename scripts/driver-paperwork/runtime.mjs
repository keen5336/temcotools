// Shared by the hosted bookmarklet and the sandboxed template preview.
// Keep this factory self-contained: the public endpoint serves its source as a classic script.
export function createDriverPaperworkRuntime(config, assets) {
  const LOGO = assets.temco;
  const HOME_DEPOT_LOGO = assets.homeDepot;
  const pageTypeLabels = { sth: 'STH - Outside Delivery', 'home-delivery': 'Home Delivery', revisit: 'Revisit' };
  const fieldLabels = { order: 'Order', dwo: 'DWO', msn: 'MSN', eta: 'ETA', weight: 'Weight', pallets: 'Pallets', serviceType: 'Service Type' };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const value = input => input === '' || input == null ? '&#8212;' : escape(input);
  const normalize = text => text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
  const field = (source, label) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return source.match(new RegExp('(?:^|\\n|\\t)' + escaped + '[ \\t]*(?::[ \\t]*|\\t+)([^\\t\\n]*)', 'i'))?.[1].trim() || '';
  };
  function richText(node, context) {
    if (node.type === 'templateField') return escape(context[node.attrs.name] ?? '');
    if (node.type === 'text') {
      let result = escape(node.text).replace(/\{\{([^{}]+)\}\}/g, (_, key) => escape(context[key.trim()] ?? ''));
      for (const mark of node.marks || []) { const tag = { bold: 'strong', italic: 'em', underline: 'u', strike: 's' }[mark.type]; if (tag) result = `<${tag}>${result}</${tag}>`; }
      return result;
    }
    if (node.type === 'hardBreak') return '<br>';
    const content = (node.content || []).map(child => richText(child, context)).join('');
    const tag = { paragraph: 'p', bulletList: 'ul', orderedList: 'ol', listItem: 'li' }[node.type];
    if (!tag) return content;
    if (!content && tag === 'p') return '';
    // List paragraphs use the established compact print spacing.
    const inner = tag === 'li' ? content.replace(/^<p>([\s\S]*?)<\/p>/, '$1') : content;
    return `<${tag}${tag === 'ol' && node.attrs?.start ? ` start="${Number(node.attrs.start)}"` : ''}>${inner}</${tag}>`;
  }
  function discoverRoutes(input) {
    const routes = new Map();
    for (const section of normalize(input).split(/HOME\s+DEPOT\s+ROUTE\s+MANIFEST/gi).slice(1)) {
      const header = section.split(/\n[ \t]*\d+[ \t]*(?:\n[ \t]*|[ \t]+)Location[ \t]*#/i)[0];
      const route = header.match(/\bSH\d+\b/i)?.[0].toUpperCase();
      if (route && !routes.has(route)) routes.set(route, { route, driver: field(header, 'Driver Name').replace(/,\s*/, ' ') || 'UNKNOWN' });
    }
    return [...routes.values()];
  }
  function parseRoute(input, route) {
    const text = normalize(input);
    if (!/^SH\d+$/.test(route)) throw new Error('Choose a route such as SH31.');

    const stopMarker = /(?:^|\n)[ \t]*(\d+)[ \t]*(?:\n[ \t]*|[ \t]+)Location[ \t]*#/gi;
    const sections = text.split(/HOME\s+DEPOT\s+ROUTE\s+MANIFEST/gi).slice(1);
    const selected = sections.filter(section => {
      const firstStop = [...section.matchAll(stopMarker)][0];
      const header = firstStop ? section.slice(0, firstStop.index) : section;
      return header.match(/\bSH\d+\b/i)?.[0].toUpperCase() === route;
    });
    if (!selected.length) {
      throw new Error(`Route ${route} not found. Open the manifest page containing that route first. The page must expose selectable HTML text.`);
    }

    const header = selected[0].split(/\n[ \t]*\d+[ \t]*(?:\n[ \t]*|[ \t]+)Location[ \t]*#/i)[0];
    const driver = field(header, 'Driver Name').replace(/,\s*/, ' ') || 'UNKNOWN';
    const date = header.match(/\bDATE\s*:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1] || '';
    const distance = selected.join('\n').match(/Total\s+Distance\s*\(mi\)\s*:\s*([\d,]+(?:\.\d+)?)/i)?.[1];
    const miles = distance == null ? null : Math.round(Number(distance.replace(/,/g, '')));
    const pageTypeFor = serviceType => {
      const normalized = serviceType.trim().toUpperCase();
      if (normalized.startsWith('MO')) return 'revisit';
      if (/^STH\b/.test(normalized)) return 'sth';
      return 'home-delivery';
    };
    for (const section of selected) {
      const h = section.split(stopMarker)[0];
      const otherDriver = field(h, 'Driver Name').replace(/,\s*/, ' ') || 'UNKNOWN';
      const otherDate = h.match(/\bDATE\s*:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1] || '';
      if (otherDriver !== driver || otherDate !== date) throw new Error(`Route ${route} contains different drivers or dates. Open one complete manifest for each route.`);
    }
    const stops = [];
    const seen = new Map();
    for (const section of selected) {
      const markers = [...section.matchAll(stopMarker)];
      for (let i = 0; i < markers.length; i++) {
        const block = section.slice(markers[i].index, markers[i + 1]?.index ?? section.length).trim();
        if (/3PL\s+MDO\s+5288/i.test(block)) continue;
        const customer = block.match(/(?:^|\t)([^\t\n]+)\t([^\t\n]*\b\d{5}(?:-\d{4})?)\t([\d,.]+)\t(\d+)(?:\t|$)/m);
        const items = block.split('\n').flatMap(line => {
          const match = line.match(/^[ \t]*(\d+(?:\.\d+)?)\t+(\d+)\t+(.*)$/);
          return match ? [{ qty: match[1], sku: match[2], description: match[3].replace(/\t+/g, ' ').trim() }] : [];
        });
        const serviceType = field(block, 'Service Type');
        const stop = {
          stop: markers[i][1],
          order: field(block, 'Customer Order #'),
          dwo: field(block, 'DWO #'),
          msn: field(block, 'MSN #'),
          eta: field(block, 'ETA'),
          serviceType,
          pageType: pageTypeFor(serviceType),
          customer: customer?.[1].trim() || '',
          address: customer?.[2].trim() || '',
          weight: customer?.[3] || '',
          pallets: customer?.[4] || '',
          items
        };
        const key = stop.stop;
        const previous = seen.get(key);
        if (previous) {
          if (JSON.stringify(previous) !== JSON.stringify(stop)) {
            throw new Error(`Stop ${stop.stop} appears more than once with different details. Open a single, complete manifest for ${route} and try again.`);
          }
          continue;
        }
        seen.set(key, stop);
        stops.push(stop);
      }
    }
    if (!stops.length) throw new Error('No delivery stops could be read for this route. Open the complete HTML manifest and try again.');
    const incomplete = stops.filter(stop => !stop.customer || !stop.address || !stop.order);
    if (incomplete.length) {
      throw new Error(`Could not read the customer, address, or order for stop(s) ${incomplete.map(stop => stop.stop).join(', ')}. The manifest text layout differs from the supplied script. No booklet was created.`);
    }
    return { route, driver, date, miles, stops };
  }
  function renderRoute({ route, driver, date, miles, stops }) {
    const sth = stops.filter(stop => /STH/i.test(stop.serviceType)).length;
    // Preserve the supplied script's classification: every other delivery is APP.
    const app = stops.length - sth;
    const editable = (label, className = '') => `<div class="write-in ${className}" contenteditable="true" spellcheck="false" role="textbox" aria-label="${escape(label)}"><br></div>`;
    const context = { route, driver, date, miles: miles ?? '' };
    const rich = (node, extra = {}) => richText(node, { ...context, ...extra });
    const inline = node => rich(node).replace(/^<p>|<\/p>$/g, '');
    const contactsHtml = config.contacts.map(row => '<div class="contact-row">' + row.map(contact => `<div><b>${escape(contact.name)}</b> <span>${escape(contact.phone)}</span></div>`).join('') + '</div>').join('');
    const surveyPanel = () => `<footer class="survey-panel" aria-label="Delivery survey reminder">
      <div class="survey-heading"><img class="survey-temco" src="${LOGO}" width="1440" height="360" alt="TEMCO Logistics"><h2>${inline(config.surveyTitle)}</h2><img class="survey-home-depot" src="${HOME_DEPOT_LOGO}" width="80" height="80" alt="The Home Depot"></div>
      <div class="survey-copy"><div class="survey-experience">${inline(config.surveyExperience)}</div><div class="survey-rating">${inline(config.surveyRating)}</div>${rich(config.surveyNotes)}</div>
      <div class="survey-team"><b>Your Delivery Team:</b><span class="survey-team-name" contenteditable="true" spellcheck="false" role="textbox" aria-label="Delivery team member 1"></span><b>&amp;</b><span class="survey-team-name" contenteditable="true" spellcheck="false" role="textbox" aria-label="Delivery team member 2"></span></div>
    </footer>`;
    const pageHeader = (title, pageType = '') => `<header class="section-header"><img src="${LOGO}" width="192" height="48" alt="TEMCO Logistics"><div><b>${escape(title)}</b>${pageType ? `<span class="service-page-type">${escape(pageTypeLabels[pageType])}</span>` : ''}${pageType && !config.pages[pageType].showRouteDate ? '' : `<span>${escape(route)} &nbsp; ${escape(date)}</span>`}</div></header>`;
    const itemTable = stop => {
      const { quantity, sku } = config.pages[stop.pageType];
      const columns = [['qty', 'Qty', quantity, '9%'], ['sku', 'SKU', sku, '19%'], ['description', 'Description', true, '']].filter(col => col[2]);
      return `<table class="items"><colgroup>${columns.map(col => `<col${col[3] ? ` style="width:${col[3]}"` : ''}>`).join('')}</colgroup><thead><tr>${columns.map(col => `<th scope="col">${col[1]}</th>`).join('')}</tr></thead><tbody>${stop.items.length ? stop.items.map(item => `<tr>${columns.map(col => `<td>${escape(item[col[0]])}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${columns.length}">No item rows could be read from the source text. Check this stop against the original manifest.</td></tr>`}</tbody></table>`;
    };
    const stopPages = stops.map(stop => `<section class="page stop-page" data-page-type="${stop.pageType}">
      <div class="stop-content">${pageHeader('STOP ' + stop.stop, stop.pageType)}
      <h1>${escape(stop.customer)}</h1><div class="address">${escape(stop.address)}</div>
      <table class="details"><tbody>${config.pages[stop.pageType].fields.map(key => `<tr><th scope="row">${fieldLabels[key]}</th><td>${value(stop[key])}</td></tr>`).join('')}</tbody></table>
      <div class="template-notes">${rich(config.pages[stop.pageType].notes, { ...stop, pageType: pageTypeLabels[stop.pageType] })}</div>
      <h2>Items</h2>${itemTable(stop)}
      </div>${surveyPanel()}</section>`).join('');
    const warnings = [];
    if (miles == null) warnings.push('Mileage was not found; the cover leaves it blank.');
    if (!date) warnings.push('The route date was not found.');
    if (driver === 'UNKNOWN') warnings.push('The driver name was not found.');
    if (stops.some(stop => !stop.items.length)) warnings.push('Some stops have no readable item rows; check their item tables.');

    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(route)} Driver Paperwork</title>
      <style>
        @page{size:letter portrait;margin:.35in}
        *{box-sizing:border-box}body{margin:0;color:#000;background:#e9e9e9;font-family:Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.25}
        .toolbar{max-width:8.5in;margin:16px auto;padding:12px 16px;background:#fff;border:1px solid #bbb;border-radius:8px;font-size:10pt;display:flex;align-items:center;gap:16px}.toolbar button{font:700 11pt Arial;padding:10px 20px;cursor:pointer;white-space:nowrap}.toolbar p{margin:3px 0}.warning{color:#8b2d00}
        .page{width:8.5in;min-height:11in;padding:.35in;margin:18px auto;background:#fff;box-shadow:0 1px 8px #0002;break-after:page}.page:last-child{break-after:auto}
        .cover{height:10.95in;min-height:10.95in;display:flex;flex-direction:column;gap:.14in}.cover>*{flex-shrink:0}.box{border:2px solid #000;border-radius:15px;padding:10px 13px;break-inside:avoid}.box h2{font-size:13pt;margin:0 0 8px;font-weight:700}.ruled-title{border-bottom:2px solid #000;padding-bottom:5px}.cover-header{display:grid;grid-template-columns:2.5in minmax(0,1fr) 1.25in;align-items:center;gap:12px;min-height:.86in}.cover-logo{width:2.5in;height:auto;display:block}.driver-block{text-align:center;min-width:0}.driver-name{font-size:16pt;font-weight:700;overflow-wrap:anywhere}.route-name{font-size:15pt;font-weight:700;margin:3px 0}.route-date{font-size:11pt}.dock-label{font-size:11pt;font-weight:700;text-align:center}.write-in{min-height:25px;border-bottom:1px solid #777;outline-offset:2px;overflow-wrap:anywhere}.dock-line{min-height:28px}
        .summary{display:grid;grid-template-columns:1.58in minmax(0,1fr);gap:.16in}.metrics{display:grid;gap:.12in}.metric{text-align:center;padding:8px}.metric h2{text-decoration:underline;margin-bottom:5px}.stop-counts{display:flex;justify-content:space-around;gap:8px}.stop-counts span{display:block;font-size:9pt;font-weight:700}.stop-counts strong,.miles-value{display:block;font-size:25pt;line-height:1.1}.contacts h2{text-align:center;text-decoration:underline;margin-bottom:9px}.contact-row{display:grid;grid-template-columns:1fr 1fr;gap:15px;font-size:10.5pt;line-height:1.45}.contact-row>div{display:flex;justify-content:space-between;gap:4px;white-space:nowrap}.contact-row span{font-variant-numeric:tabular-nums}
        ul{margin:7px 0 0;padding-left:17px;list-style-type:square}li{padding-left:1px;margin:6px 0}.reminders ul{display:grid;grid-template-columns:1fr 1fr;column-gap:20px;row-gap:0;margin-top:6px;font-size:10.5pt;font-weight:700}.attention{flex:1;min-height:1.55in}.attention .write-in{min-height:31px}.pod-title{font-size:15pt;text-align:center;margin:0 0 10px}.pod-grid{display:grid;grid-template-columns:1fr 1fr;gap:.22in}.pod-box h3{font-size:12pt;text-align:center;margin:0 0 9px}.pod-box li{font-size:10.5pt;margin:6px 0}.signature{display:flex;align-items:flex-end;gap:9px;padding:12px 8px 4px;font-size:11pt}.signature .write-in{flex:1;min-height:24px}
        .section-header{display:flex;align-items:center;justify-content:space-between;border:2px solid #000;border-radius:12px;padding:12px 15px;margin-bottom:22px;gap:12px}.section-header img{width:2in;height:auto;display:block}.section-header>div{text-align:right}.section-header b{font-size:19pt;display:block}.section-header span{display:block;font-size:11pt;margin-top:4px}h1{font-size:23pt;margin:0 0 8px;overflow-wrap:anywhere}h2{font-size:14pt;margin:22px 0 8px}.address{font-size:14pt;margin-bottom:20px;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;font-size:10.5pt}th,td{border:1px solid #000;padding:8px;text-align:left;vertical-align:top;overflow-wrap:anywhere}thead{display:table-header-group}tr{break-inside:avoid}th{font-weight:700}.details th{width:23%}.items,.manifest{table-layout:fixed}.manifest td:first-child,.manifest th:first-child{text-align:center}.manifest-caption{font-size:11pt;margin:8px 0 14px}
        .stop-page{height:10.95in;min-height:10.95in;display:flex;flex-direction:column}.stop-content{flex:1;min-height:0}.survey-panel{flex:none;background:#ffeb73;color:#000;border:2px solid #000;padding:9px 11px;margin-top:.16in;break-inside:avoid;print-color-adjust:exact;-webkit-print-color-adjust:exact;font-size:8.5pt;line-height:1.18;font-weight:700}.survey-heading{display:grid;grid-template-columns:1.45in minmax(0,1fr) .62in;align-items:start;gap:8px;margin-bottom:5px}.survey-heading h2{font-size:19pt;line-height:1.08;text-align:center;margin:0}.survey-temco{width:1.45in;height:auto;margin-top:7px;mix-blend-mode:multiply}.survey-home-depot{width:.62in;height:.62in;background:#f96302}.survey-panel .survey-copy{margin:0}.survey-copy ul,.survey-copy ol{margin:0;padding-left:15px}.survey-copy>div{margin:3px 0}.survey-panel li{margin:3px 0;padding-left:1px}.survey-panel .survey-experience{font-size:10.25pt;text-align:center}.survey-panel .survey-rating{font-size:9pt;text-align:center}.survey-team{display:flex;align-items:baseline;gap:7px;border:2px solid #000;padding:5px 7px;margin-top:7px;font-size:11pt}.survey-team-name{flex:1;min-width:0;min-height:18px;border-bottom:1px solid #000;white-space:nowrap;overflow:hidden;outline-offset:2px}p{margin:5px 0}.template-notes:empty{display:none}.template-notes{margin-top:12px}.continuation-label{font-size:11pt;font-weight:400}
        @media print{body{background:#fff}.toolbar{display:none!important}.page{width:auto;min-height:0;padding:0;margin:0;box-shadow:none}.cover{height:10.25in;min-height:10.25in}.box{break-inside:avoid}.page:last-child{break-after:auto}a{color:inherit;text-decoration:none}[contenteditable]{outline:none}}
        @media print{.stop-page{height:10.25in;min-height:10.25in;break-inside:avoid}}
      </style></head><body>
      <nav class="toolbar" aria-label="Print controls"><button id="print-booklet" type="button">Print / Save PDF</button><div><p><b>${escape(route)} · ${stops.length} delivery stops</b></p><p>Click dock/wave, notes or delivery team names to type before printing. Use Letter, 100% scale, and turn off browser headers and footers. Print in color for the yellow survey panel.</p>${warnings.map(warning => `<p class="warning">${escape(warning)}</p>`).join('')}</div></nav>
      <section class="page cover" data-route="${escape(route)}">
        <header class="box cover-header"><img class="cover-logo" src="${LOGO}" width="1440" height="360" alt="TEMCO Logistics"><div class="driver-block"><div class="driver-name">${escape(driver)}</div><div class="route-name">${escape(route)}</div><div class="route-date">${value(date)}</div></div><div><div class="dock-label">DOCK/WAVE</div>${editable('Dock or wave', 'dock-line')}</div></header>
        <div class="summary"><div class="metrics"><section class="box metric"><h2>STOPS</h2><div class="stop-counts"><div><span>STH</span><strong>${sth}</strong></div><div><span>APP</span><strong>${app}</strong></div></div></section><section class="box metric"><h2>MILES</h2><strong class="miles-value">${miles == null ? '&#8212;' : miles}</strong></section></div><section class="box contacts"><h2>MANAGEMENT CONTACTS</h2>${contactsHtml}</section></div>
        <section class="box reminders"><h2 class="ruled-title">DRIVER REMINDERS</h2>${rich(config.coverReminders)}</section>
        <section class="box attention"><h2 class="ruled-title">SPECIAL ATTENTION</h2>${rich(config.coverAttention)}${[1,2,3,4].map(number => editable('Special attention line ' + number)).join('')}</section>
        <section class="pod"><h2 class="pod-title">POD COMPLIANCE</h2><div class="pod-grid"><section class="box pod-box"><h3>APP</h3>${rich(config.appPod)}</section><section class="box pod-box"><h3>STH</h3>${rich(config.sthPod)}</section></div></section>
        <footer class="signature"><b>Driver Check-In Signature:</b>${editable('Driver check-in signature')}</footer>
      </section>
      <section class="page manifest-page">${pageHeader('ROUTE MANIFEST')}<p class="manifest-caption">Driver: <b>${escape(driver)}</b> &nbsp; | &nbsp; ${stops.length} delivery stops &nbsp; | &nbsp; ${miles == null ? 'Mileage unavailable' : miles + ' miles'}</p><table class="manifest"><colgroup><col style="width:10%"><col style="width:25%"><col></colgroup><thead><tr><th scope="col">Stop</th><th scope="col">Order</th><th scope="col">Customer</th></tr></thead><tbody>${stops.map(stop => `<tr><td>${escape(stop.stop)}</td><td>${escape(stop.order)}</td><td>${escape(stop.customer)}</td></tr>`).join('')}</tbody></table></section>
      ${stopPages}</body></html>`;

    return html;
  }
  function buildBooklet(input, routes) {
    if (!routes.length) throw new Error('Choose at least one route.');
    const unique = [...new Set(routes)];
    // Validate every chosen route before producing any partial batch.
    const parsed = unique.map(route => parseRoute(input, route));
    const documents = parsed.map(renderRoute);
    let html = documents[0];
    if (documents.length > 1) {
      const more = documents.slice(1).map(doc => doc.match(/<section class="page cover"[\s\S]*?(?=<\/body>)/)[0]).join('');
      const warnings = documents.flatMap((doc, index) => [...doc.matchAll(/<p class="warning">([\s\S]*?)<\/p>/g)].map(match => `<p class="warning">${unique[index]}: ${match[1]}</p>`)).join('');
      html = html.replace(/<p class="warning">[\s\S]*?<\/p>/g, '').replace('</div></nav>', warnings + '</div></nav>');
      html = html.replace('</body>', more + '</body>').replace(/<title>[^<]*<\/title>/, '<title>All Routes · Driver Paperwork</title>');
      html = html.replace(/<b>SH\d+ · \d+ delivery stops<\/b>/, `<b>${parsed.length} routes · ${parsed.reduce((sum, p) => sum + p.stops.length, 0)} delivery stops</b>`);
    }
    return html;
  }
  function paginate(booklet) {
    // Screen and print have the same 7.8 x 10.25 inch usable stop area. Split
    // item rows before printing so every physical stop sheet has its own footer.
    for (const firstSheet of [...booklet.document.querySelectorAll('.stop-page')]) {
      const rows = [...firstSheet.querySelector('.items tbody').children];
      const firstBody = firstSheet.querySelector('.items tbody');
      rows.forEach(row => row.remove());
      const template = firstSheet.cloneNode(true);
      let sheet = firstSheet;
      let body = firstBody;
      const fits = () => {
        const content = sheet.querySelector('.stop-content');
        return content.scrollHeight <= content.clientHeight + 1;
      };
      if (!fits()) throw new Error('The stop details are too long to fit above the survey panel. No printable booklet was prepared.');
      for (const row of rows) {
        body.appendChild(row);
        if (fits()) continue;
        row.remove();
        const next = template.cloneNode(true);
        next.dataset.continuation = 'true';
        next.querySelector('.details')?.remove();
        next.querySelector('.template-notes')?.remove();
        const continued = booklet.document.createElement('span');
        continued.className = 'continuation-label';
        continued.textContent = ' (continued)';
        next.querySelector('.section-header b').appendChild(continued);
        sheet.after(next);
        sheet = next;
        body = sheet.querySelector('.items tbody');
        body.appendChild(row);
        if (!fits()) throw new Error('An item description is too long to fit on a stop sheet above the survey panel. No printable booklet was prepared.');
      }
    }
    for (const cover of booklet.document.querySelectorAll('.cover')) {
      if (cover.scrollHeight > cover.clientHeight + 1) throw new Error('The cover template is too long for one Letter page. Shorten the cover text and preview again.');
    }
  }
  function prepareBooklet(booklet, html) {
    booklet.opener = null;
    booklet.document.open(); booklet.document.write(html); booklet.document.close();
    paginate(booklet);
    const printButton = booklet.document.getElementById('print-booklet');
    printButton.addEventListener('click', async () => {
      printButton.disabled = true;
      try {
        await Promise.all([...booklet.document.images].map(image => image.decode()));
        if (booklet.document.fonts?.ready) await booklet.document.fonts.ready;
        // Recheck after manual notes and print-time image/font loading.
        for (const sheet of booklet.document.querySelectorAll('.stop-page')) {
          const content = sheet.querySelector('.stop-content');
          if (content.scrollHeight > content.clientHeight + 1) throw new Error('Your notes no longer fit above the survey. Shorten them before printing.');
        }
        for (const cover of booklet.document.querySelectorAll('.cover')) if (cover.scrollHeight > cover.clientHeight + 1) throw new Error('Your cover notes no longer fit on one page. Shorten them before printing.');
        booklet.focus(); booklet.print();
      } catch (error) { booklet.alert(error?.message || 'A logo image could not load. Check the booklet before printing.'); }
      finally { printButton.disabled = false; }
    });
    booklet.focus();
  }
  function mount() {
    const job = document.currentScript?.temcoDriverPaperwork;
    if (!job || window.__temcoDriverPaperwork !== job) return;
    // Existing installed loaders opened a loading window before the download.
    // Generation now happens on the panel's click, which has its own popup grant.
    if (job.booklet && !job.booklet.closed) job.booklet.close();
    window.__temcoDriverPaperworkApp?.stop();
    const host = document.createElement('div');
    host.id = 'temco-driver-paperwork';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host{all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483647;width:360px;max-width:calc(100vw - 32px);font:14px/1.4 Arial,sans-serif;color:#17212f}
      *{box-sizing:border-box}.panel{background:white;border:1px solid #cbd5e1;border-radius:14px;box-shadow:0 10px 40px #0005;padding:18px}header{display:flex;align-items:center;justify-content:space-between;gap:12px}h2{font-size:18px;margin:0}button,select{font:inherit}button{cursor:pointer;border:1px solid #cbd5e1;border-radius:7px;padding:8px 12px;background:#f1f5f9;color:inherit}button:disabled{opacity:.5;cursor:default}.close{border:0;background:none;font-size:22px;padding:0 4px}label{display:block;font-weight:bold;margin:14px 0 6px}select{width:100%;padding:10px;border:1px solid #94a3b8;border-radius:7px;background:white;color:inherit}.actions{display:flex;gap:8px;margin-top:14px}.generate{background:#166534;color:white;border-color:#166534;flex:1}p{margin:10px 0 0}.hint{font-size:12px;color:#475569}.status{white-space:pre-wrap;overflow-wrap:anywhere}.error{color:#9f1239}
    </style><section class="panel" aria-label="Driver Paperwork"><header><h2>Driver Paperwork</h2><button class="close" aria-label="Close Driver Paperwork">×</button></header><label for="route">Driver / route</label><select id="route"></select><div class="actions"><button class="generate">Create booklet</button><button class="refresh">Refresh</button></div><p class="status" role="status" aria-live="polite"></p><p class="hint">All routes creates one booklet with a cover and stop sheets for each driver. Your manifest stays in this browser.</p></section>`;
    let text = '';
    let routes = [];
    const select = shadow.querySelector('select');
    const status = shadow.querySelector('.status');
    const generate = shadow.querySelector('.generate');
    function readManifest() {
      // Shadow DOM text is excluded from body.innerText; temporarily hide the
      // host as well so future panel changes cannot become parser input.
      host.style.display = 'none';
      try { return document.body?.innerText || ''; } finally { host.style.display = ''; }
    }
    function refresh() {
      text = readManifest(); routes = discoverRoutes(text);
      const previous = select.value; select.replaceChildren();
      const all = document.createElement('option'); all.value = '*'; all.textContent = `All routes (${routes.length})`; select.appendChild(all);
      for (const route of routes) { const option = document.createElement('option'); option.value = route.route; option.textContent = `${route.route} — ${route.driver}`; select.appendChild(option); }
      select.value = routes.some(r => r.route === previous) ? previous : routes.length === 1 ? routes[0].route : '*';
      generate.disabled = !routes.length;
      status.className = 'status' + (routes.length ? '' : ' error');
      status.textContent = routes.length ? `${routes.length} route${routes.length === 1 ? '' : 's'} found. Choose a driver or all routes.` : 'No routes found. Open the complete HTML manifest with selectable text, then choose Refresh.';
    }
    generate.addEventListener('click', () => {
      let booklet;
      try {
        // Read fresh source on every generation; never print a stale manifest.
        booklet = window.open('', '_blank');
        if (!booklet) throw new Error('Allow pop-ups for this manifest page, then choose Create booklet again.');
        booklet.opener = null;
        booklet.document.title = 'Driver Paperwork';
        booklet.document.body.textContent = 'Preparing Driver Paperwork…';
        const latestText = readManifest();
        const chosen = select.value === '*' ? discoverRoutes(latestText).map(r => r.route) : [select.value];
        const html = buildBooklet(latestText, chosen);
        prepareBooklet(booklet, html);
        status.className = 'status'; status.textContent = `Booklet ready for ${chosen.length} route${chosen.length === 1 ? '' : 's'}. Review it before printing.`;
      } catch (error) {
        if (booklet && !booklet.closed) booklet.close();
        status.className = 'status error'; status.textContent = error?.message || 'Could not create the booklet.';
      }
    });
    const app = { stop() { host.remove(); if (window.__temcoDriverPaperworkApp === app) delete window.__temcoDriverPaperworkApp; } };
    shadow.querySelector('.close').addEventListener('click', () => app.stop());
    shadow.querySelector('.refresh').addEventListener('click', refresh);
    document.body.appendChild(host); window.__temcoDriverPaperworkApp = app;
    refresh(); job.finished = true; select.focus();
  }
  return { discoverRoutes, parseRoute, buildBooklet, paginate, prepareBooklet, mount };
}

const token = document.querySelector('meta[name="worldatlas-token"]').content;
const $ = (selector) => document.querySelector(selector);
const KIND = {
  story: {label:'Сюжет', icon:'◇', singular:'сюжетную запись', fields:[['type','Тип записи','Арка, глава, эпизод или сцена'],['logline','Суть','Что здесь происходит?'],['goal','Цель','К чему стремятся герои?'],['conflict','Конфликт','Что мешает?'],['outcome','Итог','Что меняется после события?']]},
  character: {label:'Персонажи', icon:'♟', singular:'персонажа', fields:[['role','Роль в сюжете','Главный герой, наставник, антагонист…'],['personality','Характер','Черты, привычки, слабости'],['appearance','Внешность','Приметы и особенности'],['clothing','Одежда','Обычный облик, варианты костюма'],['motivation','Мотивация','Чего хочет и почему?'],['arc','Развитие','Как меняется по ходу истории?']]},
  place: {label:'Места', icon:'⌂', singular:'место', fields:[['region','Регион','Где находится?'],['atmosphere','Атмосфера','Что чувствует посетитель?'],['appearance','Облик','Архитектура, природа, детали'],['history','История','Что произошло здесь раньше?'],['secrets','Тайны','Что скрыто?']]},
  item: {label:'Предметы', icon:'✧', singular:'предмет', fields:[['category','Тип','Артефакт, оружие, документ…'],['appearance','Внешний вид','Как выглядит?'],['origin','Происхождение','Кто создал или нашёл?'],['significance','Значение в сюжете','Почему это важно?']]},
  faction: {label:'Фракции', icon:'♜', singular:'фракцию', fields:[['purpose','Цель','Чего добивается группа?'],['beliefs','Принципы','Во что верят участники?'],['structure','Устройство','Лидеры, роли, правила'],['relations','Отношения','Союзники и противники']]},
  lore: {label:'Устройство мира', icon:'◈', singular:'правило мира', fields:[['category','Тема','Магия, культура, история, технология…'],['rule','Правило','Как это работает?'],['limits','Ограничения','Чего сделать нельзя?'],['consequences','Последствия','Как это влияет на жизнь и сюжет?']]},
  event: {label:'Хронология', icon:'◷', singular:'событие', fields:[['when','Когда','Дата или относительное время'],['location','Где','Место события'],['participants','Участники','Кто присутствовал?'],['impact','Последствия','Что изменилось?']]},
  other: {label:'Другое', icon:'◌', singular:'эту запись', fields:[['category','Тип','Народ, существо, язык, обычай, технология…'],['role','Значение','Какую роль играет в мире?']]},
};
const S = {data:null, settings:{theme:'modern',avatars_enabled:false}, view:'dashboard', selected:null, current:null, revision:null, dirty:false, projectSettingsDirty:false, editVersion:0, timer:null, saving:null, conflict:false, inspect:null, toastTimer:null};
const GENRES = ['Фэнтези','Научная фантастика','Исторический','Детектив','Приключения','Мистика','Ужасы','Драма','Постапокалипсис'];

function escapeHtml(value='') {return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function formatDate(value) {if(!value) return ''; const d=new Date(value); return Number.isNaN(d.getTime())?'':new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',year:'numeric'}).format(d);}
function showToast(message,error=false) {const t=$('#toast'); t.textContent=message; t.classList.toggle('error',error); t.classList.remove('hidden'); clearTimeout(S.toastTimer); S.toastTimer=setTimeout(()=>t.classList.add('hidden'),5500);}
function status(text,type='') {const e=$('#save-status');e.textContent=text;e.className=`save-status ${type}`;}
async function api(path,method='GET',body=null) {
  const options={method,headers:{'X-WorldAtlas-Token':token}};
  if(body!==null){options.headers['Content-Type']='application/json';options.body=JSON.stringify(body);}
  let response;
  try {response=await fetch(path,options);} catch {throw new Error('Нет связи с приложением. Проверьте, что оно запущено.');}
  let data;try{data=await response.json();}catch{throw new Error('Не удалось прочитать ответ приложения.');}
  if(!response.ok){const error=new Error(data.error||'Ошибка запроса');error.status=response.status;throw error;}
  return data;
}

async function init(){
  try{const data=await api('/api/state');S.settings=data.settings||{theme:'modern',avatars_enabled:false};document.body.dataset.theme=S.settings.theme;renderRecents(data.recents||[]);if(data.project_data){S.data=data.project_data;showApp();}else showWelcome();}
  catch(error){showWelcome();showToast(error.message,true);}
  bindGlobal();
}
function bindGlobal(){
  $('#browse-button').onclick=async()=>{try{const r=await api('/api/pick-folder','POST');if(r.path){$('#folder-path').value=r.path;await inspectFolder();}}catch(e){showToast(e.message,true);}};
  $('#folder-path').addEventListener('input',()=>{clearTimeout(S.inspectTimer);S.inspectTimer=setTimeout(inspectFolder,450);});
  $('#folder-path').addEventListener('keydown',e=>{if(e.key==='Enter')openFolder();});
  $('#open-button').onclick=openFolder;
  $('#project-switch').onclick=async()=>{if(S.projectSettingsDirty&&!await saveProjectSettings(false))return;if(await flushSave())showWelcome();};
  $('#new-button').onclick=()=>newEntry();
  $('#import-button').onclick=()=>$('#import-file').click();
  $('#import-file').onchange=importMarkdown;
  $('#collection-add').onclick=()=>newEntry();
  $('#search').addEventListener('input',renderList);
  $('#backup-button').onclick=createBackup;
  $('#quit-button').onclick=quitApp;
  $('#app-settings-button').onclick=showAppSettings;
  $('#modal-close').onclick=closeModal;
  $('#modal').addEventListener('click',e=>{if(e.target.id==='modal')closeModal();});
  $('#lightbox-close').onclick=closeImageLightbox;
  $('#image-lightbox').addEventListener('click',e=>{if(e.target.id==='image-lightbox')closeImageLightbox();});
  document.addEventListener('keydown',e=>{
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();S.view==='project_settings'?saveProjectSettings():flushSave();}
    if(e.key==='Escape'){closeImageLightbox();closeModal();}
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&S.dirty)flushSave();});
  window.addEventListener('beforeunload',e=>{if(S.dirty||S.saving||S.projectSettingsDirty){e.preventDefault();e.returnValue='';}});
}
function showWelcome(){S.view='dashboard';$('#app').classList.add('hidden');$('#welcome').classList.remove('hidden');$('#folder-path').value='';$('#folder-hint').textContent='Выберите существующий проект или папку для нового.';$('#open-button').textContent='Открыть проект';S.inspect=null;api('/api/state').then(x=>renderRecents(x.recents||[])).catch(()=>{});}
function renderRecents(recents){const wrap=$('#recents-wrap'),list=$('#recents');list.replaceChildren();wrap.classList.toggle('hidden',recents.length===0);for(const path of recents){const b=document.createElement('button');b.className='recent-project';const name=path.replace(/[\\/]$/,'').split(/[\\/]/).pop();b.innerHTML=`<strong>${escapeHtml(name)}</strong><small>${escapeHtml(path)}</small>`;b.onclick=()=>{$('#folder-path').value=path;inspectFolder().then(openFolder);};list.append(b);}}
async function inspectFolder(){const path=$('#folder-path').value.trim(),hint=$('#folder-hint');S.inspect=null;hint.classList.remove('error');if(!path){hint.textContent='Выберите существующий проект или папку для нового.';return;}try{const info=await api('/api/project/inspect','POST',{path});S.inspect=info;if(info.is_project){hint.textContent=`Найден проект «${info.title}».`;$('#open-button').textContent='Открыть проект';}else{hint.textContent=info.exists?'В этой папке можно создать новый мир.':'Папка будет создана вместе с новым миром.';$('#open-button').textContent='Создать мир';}}catch(e){hint.textContent=e.message;hint.classList.add('error');}}
async function openFolder(){const path=$('#folder-path').value.trim();if(!path){showToast('Укажите папку проекта.',true);return;}try{if(!S.inspect||S.inspect.path.toLowerCase()!==path.toLowerCase())await inspectFolder();if(!S.inspect)return;const isProject=S.inspect.is_project;const result=await api('/api/project/open','POST',{path:S.inspect.path,create:!isProject});S.data=result;S.selected=null;S.current=null;S.revision=null;S.dirty=false;showApp();showToast(isProject?'Проект открыт':'Мир создан');}catch(e){showToast(e.message,true);}}
function showApp(){$('#welcome').classList.add('hidden');$('#app').classList.remove('hidden');S.view=S.data.project.setup_complete===false?'project_settings':'dashboard';renderShell();renderView();}
function renderShell(){const p=S.data.project;$('#project-name-side').textContent=p.title;$('#project-name-head').textContent=p.title;const warn=$('#warnings');warn.classList.toggle('hidden',!S.data.warnings?.length);warn.textContent=S.data.warnings?.length?`Не удалось прочитать ${S.data.warnings.length} файл(ов): ${S.data.warnings.slice(0,3).join(' • ')}`:'';const entries=S.data.entries.filter(e=>!e.deleted);const sections=p.setup_complete===false?[['project_settings','Настройки проекта','⚙']]:[['dashboard','Обзор','◫'],['project_settings','Настройки проекта','⚙'],['all','Все записи','▦'],...Object.entries(KIND).map(([key,x])=>[key,x.label,x.icon]),['trash','Корзина','♻']];const nav=$('#nav');nav.replaceChildren();for(const [key,label,icon] of sections){const count=key==='dashboard'||key==='project_settings'?'':key==='all'?entries.length:key==='trash'?S.data.entries.filter(e=>e.deleted).length:entries.filter(e=>e.kind===key).length;const b=document.createElement('button');b.className=`nav-item ${S.view===key?'active':''}`;b.innerHTML=`<span class="nav-icon">${icon}</span><span>${label}</span><b>${count}</b>`;b.onclick=async()=>{if(S.view==='project_settings'&&S.projectSettingsDirty&&!await saveProjectSettings(false))return;if(await flushSave()){S.view=key;S.selected=null;S.current=null;renderShell();renderView();}};nav.append(b);}}
function renderView(){const dashboard=S.view==='dashboard',settings=S.view==='project_settings';$('#dashboard').classList.toggle('hidden',!dashboard);$('#project-settings').classList.toggle('hidden',!settings);$('#content').classList.toggle('hidden',dashboard||settings);$('#section-name').textContent=dashboard?'Обзор':settings?'Настройки проекта':S.view==='all'?'Все записи':S.view==='trash'?'Корзина':KIND[S.view].label;$('#new-button').classList.toggle('hidden',settings||S.view==='trash');$('#import-button').classList.toggle('hidden',settings||S.view==='trash');if(dashboard)renderDashboard();else if(settings)renderProjectSettings();else renderCollection();}
function renderDashboard(){const p=S.data.project,entries=S.data.entries.filter(e=>!e.deleted);const byKind=kind=>entries.filter(e=>e.kind===kind).length;const stats=[['Сюжет',byKind('story'),'story'],['Персонажи',byKind('character'),'character'],['Места',byKind('place'),'place'],['Всего записей',entries.length,'all']];const recent=[...entries].sort((a,b)=>(b.updated_at||'').localeCompare(a.updated_at||'')).slice(0,6);$('#dashboard').innerHTML=`<div class="dashboard-hero"><div class="eyebrow">ВАША ТВОРЧЕСКАЯ ВСЕЛЕННАЯ</div><h1>${escapeHtml(p.title)}</h1><p>${escapeHtml(p.summary||'Соберите здесь сюжет, героев, места и законы мира. Каждая запись сразу становится частью документации проекта.')}</p><button id="dashboard-start" class="primary-button">＋ Продолжить историю</button></div><div class="dashboard-grid">${stats.map(s=>`<div class="stat-card" data-stat="${s[2]}"><div class="eyebrow">${s[0].toUpperCase()}</div><div class="number">${s[1]}</div><div class="label">Открыть раздел →</div></div>`).join('')}</div><h2 class="section-title">Недавние записи</h2><div class="recent-grid">${recent.length?recent.map(e=>`<button class="recent-card" data-recent="${e.id}"><span class="eyebrow">${KIND[e.kind].label.toUpperCase()}</span><strong>${escapeHtml(e.title)}</strong><small>Изменено ${formatDate(e.updated_at)}</small></button>`).join(''):'<p style="color:var(--muted)">Записей пока нет. Создайте первую сюжетную арку или персонажа.</p>'}</div>`;$('#dashboard-start').onclick=()=>newEntry('story');document.querySelectorAll('[data-stat]').forEach(e=>e.onclick=()=>{S.view=e.dataset.stat;renderShell();renderView();});document.querySelectorAll('[data-recent]').forEach(e=>e.onclick=()=>{S.view='all';renderShell();renderView();selectEntry(e.dataset.recent);});}
function renderCollection(){$('#collection-title').textContent=S.view==='all'?'Все записи':S.view==='trash'?'Корзина':KIND[S.view].label;$('#collection-eyebrow').textContent=S.view==='trash'?'ВОССТАНОВЛЕНИЕ':'БИБЛИОТЕКА МИРА';$('#collection-add').classList.toggle('hidden',S.view==='trash');$('#search').value='';renderList();if(S.current&&S.selected)renderEditor();else renderEmptyEditor();}
function filteredEntries(){
  const query=$('#search').value.toLocaleLowerCase().trim();
  const entries=S.data.entries.filter(e=>S.view==='trash'?e.deleted:!e.deleted&&(S.view==='all'||e.kind===S.view));
  const matches=entries.filter(e=>!query||[e.title,e.status,...(e.tags||[])].join(' ').toLocaleLowerCase().includes(query));
  if(S.view==='story'&&!query){
    const ids=new Set(matches.map(e=>e.id)),children=new Map(),visited=new Set(),ordered=[];
    const compare=(a,b)=>(a.order||0)-(b.order||0)||a.title.localeCompare(b.title,'ru');
    for(const entry of matches){const parent=entry.parent_id&&ids.has(entry.parent_id)?entry.parent_id:'';if(!children.has(parent))children.set(parent,[]);children.get(parent).push(entry);}
    for(const group of children.values())group.sort(compare);
    function visit(entry,depth){if(visited.has(entry.id))return;visited.add(entry.id);ordered.push({...entry,_depth:depth});for(const child of children.get(entry.id)||[])visit(child,depth+1);}
    for(const root of children.get('')||[])visit(root,0);
    for(const entry of matches)visit(entry,0);
    return ordered;
  }
  if(S.view==='event'&&!query)return matches.sort((a,b)=>(a.order||0)-(b.order||0)||a.title.localeCompare(b.title,'ru'));
  return matches.sort((a,b)=>(b.updated_at||'').localeCompare(a.updated_at||''));
}
function renderList(){
  const entries=filteredEntries(),list=$('#list');list.replaceChildren();
  $('#list-footer').textContent=`${entries.length} ${entries.length===1?'запись':'записей'}`;
  if(!entries.length){list.innerHTML='<div style="color:var(--muted);font-size:12px;padding:20px">Здесь пока пусто.</div>';return;}
  for(const e of entries){
    const b=document.createElement('button');b.className=`entry-row ${S.selected===e.id?'active':''}`;
    if(e._depth)b.style.paddingLeft=`${12+Math.min(e._depth,8)*14}px`;
    const indent=e._depth?'↳ ':'';
    b.innerHTML=`<span class="row-title">${indent?`<span class="row-indent">${indent}</span>`:''}${escapeHtml(e.title)}</span><span class="row-meta">${S.view==='all'||S.view==='trash'?KIND[e.kind].label+' · ':''}${escapeHtml(e.status||'Черновик')}${e.tags?.length?' · '+escapeHtml(e.tags.slice(0,2).join(', ')):''}</span>`;
    b.onclick=()=>selectEntry(e.id);list.append(b);
  }
}
function renderEmptyEditor(){const editor=$('#editor');editor.classList.remove('avatar-layout');$('#content').classList.remove('avatar-active');editor.innerHTML='<div class="empty-editor"><div class="empty-symbol">✧</div><h2>Выберите запись</h2><p>Или создайте новую, чтобы начать описывать мир.</p></div>';}
function updateAvatarPanel(){
  const editor=$('#editor');
  if(!editor)return;
  const visible=Boolean(S.settings.avatars_enabled&&S.current?.image);
  $('#content').classList.toggle('avatar-active',visible);
  let panel=editor.querySelector('.avatar-panel');
  if(!visible){
    if(panel){const main=editor.querySelector('.editor-main');main.replaceWith(...Array.from(main.childNodes));panel.remove();}
    editor.classList.remove('avatar-layout');
    return;
  }
  if(!panel){
    const main=document.createElement('div');main.className='editor-main';
    while(editor.firstChild)main.append(editor.firstChild);
    panel=document.createElement('aside');panel.className='avatar-panel';
    panel.innerHTML='<button class="avatar-frame" type="button" aria-label="Открыть изображение"><img alt=""></button>';
    editor.append(panel,main);
  }
  const picture=panel.querySelector('img');
  panel.querySelector('.avatar-frame').onclick=()=>openImageLightbox(picture.src,picture.alt);
  picture.onload=()=>{
    const scale=Math.min(232/picture.naturalWidth,325/picture.naturalHeight);
    if(!Number.isFinite(scale)||scale<=0)return;
    const width=Math.max(1,Math.round(picture.naturalWidth*scale));
    const height=Math.max(1,Math.round(picture.naturalHeight*scale));
    panel.style.width=`${Math.max(170,width+26)}px`;
    const frame=panel.querySelector('.avatar-frame');
    frame.style.width=`${width}px`;
    frame.style.height=`${height}px`;
  };
  picture.src=`/asset/${S.current.image}?token=${encodeURIComponent(token)}`;
  picture.alt=`Изображение: ${S.current.title}`;
  editor.classList.add('avatar-layout');
}
async function selectEntry(id){if(S.selected===id)return;if(!await flushSave())return;try{const result=await api(`/api/entry/${id}`);S.selected=id;S.current=result.entry;S.revision=result.revision;S.dirty=false;S.conflict=false;renderList();renderEditor();status('Все изменения сохранены');}catch(e){showToast(e.message,true);}}
function fieldInput(key,label,placeholder){return `<div class="full-field"><label>${escapeHtml(label)}</label><textarea data-field="${escapeHtml(key)}" rows="2" placeholder="${escapeHtml(placeholder)}">${escapeHtml(S.current.fields?.[key]||'')}</textarea></div>`;}
function renderEditor(){const e=S.current;if(!e){renderEmptyEditor();return;}const k=KIND[e.kind],fixed=new Set(k.fields.map(x=>x[0]));const extra=Object.entries(e.fields||{}).filter(([key])=>!fixed.has(key));const parents=S.data.entries.filter(x=>x.kind==='story'&&!x.deleted&&x.id!==e.id);const kindFields=k.fields.map(f=>fieldInput(...f)).join('');const image=e.image?`<img src="/asset/${e.image}?token=${encodeURIComponent(token)}" alt="Изображение записи">`:'✧';$('#editor').innerHTML=`<div class="editor-top"><span class="eyebrow">${k.label.toUpperCase()} / ${escapeHtml(e.status||'Черновик')}</span><div class="editor-buttons">${e.deleted?'<button id="restore-entry" class="secondary-button">Восстановить</button>':'<button id="trash-entry" class="quiet-button">В корзину</button>'}</div></div><input id="entry-title" class="editor-title" maxlength="160" value="${escapeHtml(e.title)}" placeholder="Название записи"><div class="editor-subtitle">Создано ${formatDate(e.created_at)} · Изменено ${formatDate(e.updated_at)} · ${e.id.slice(0,8)}</div><div id="conflict-banner" class="warnings ${S.conflict?'':'hidden'}">Файл изменился вне приложения. Ваш текст остался в редакторе. <button id="download-draft" class="small-link">Скачать мои правки</button><button id="reload-entry" class="small-link">Загрузить файл с диска</button></div><div class="editor-card"><h3>Основное</h3><div class="field-grid"><div class="field"><label for="entry-status">Статус</label><select id="entry-status">${['Черновик','В работе','Канон','Архив'].map(v=>`<option ${e.status===v?'selected':''}>${v}</option>`).join('')}</select></div><div class="field"><label for="entry-tags">Метки</label><input id="entry-tags" value="${escapeHtml((e.tags||[]).join(', '))}" placeholder="Через запятую"></div>${e.kind==='story'?`<div class="field"><label for="entry-parent">Внутри</label><select id="entry-parent"><option value="">Корень сюжета</option>${parents.map(p=>`<option value="${p.id}" ${e.parent_id===p.id?'selected':''}>${escapeHtml(p.title)}</option>`).join('')}</select></div><div class="field"><label for="entry-order">Порядок</label><input id="entry-order" type="number" min="0" max="99999" value="${e.order||0}"></div>`:''}</div></div><div class="editor-card"><h3>Детали ${k.singular}</h3><div class="field-grid">${kindFields}</div><div id="custom-fields" style="margin-top:14px">${extra.map(([key,value])=>customRow(key,value)).join('')}</div><button id="add-field" class="small-link">＋ Добавить своё поле</button></div><div class="editor-card body-card"><div class="body-toolbar"><h3>Подробное описание</h3><div class="tab-buttons"><button id="edit-tab" class="active">Редактор</button><button id="preview-tab">Просмотр</button></div></div><textarea id="entry-body" class="body-input" placeholder="Расскажите историю подробно. Можно использовать Markdown: заголовки, списки, выделение…">${escapeHtml(e.body||'')}</textarea><div id="body-preview" class="body-preview hidden"></div></div><div class="editor-card"><h3>Изображение</h3><div class="image-area"><div id="image-preview" class="image-preview">${image}</div><div class="image-controls"><button id="upload-image" class="secondary-button">Выбрать изображение</button>${e.image?'<button id="remove-image" class="small-link">Убрать из записи</button>':''}<small>PNG, JPEG, WebP или GIF · до 12 МБ</small><input id="image-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden></div></div></div><div class="editor-card"><h3>Связи с другими записями</h3><div id="links" class="link-list"></div><div class="link-adder"><select id="link-select"></select><button id="add-link" class="secondary-button">Связать</button></div></div><div class="editor-bottom"><span>Изменения сохраняются автоматически. Ctrl+S — сохранить сейчас.</span><button id="save-now" class="small-link">Сохранить</button></div>`;
  if(e.kind==='event'){
    const field=document.createElement('div');field.className='field';
    field.innerHTML=`<label for="entry-order">Порядок события</label><input id="entry-order" type="number" min="0" max="99999" value="${e.order||0}">`;
    $('#editor .editor-card .field-grid').append(field);
  }
  if(e.status&&!Array.from($('#entry-status').options).some(option=>option.value===e.status)){
    const option=document.createElement('option');option.value=e.status;option.textContent=e.status;$('#entry-status').append(option);$('#entry-status').value=e.status;
  }
  $('#image-file').accept='image/png,.png';
  $('#image-preview').parentElement.querySelector('small').textContent='PNG · до 12 МБ. Ранее загруженные изображения других форматов остаются доступными.';
  updateAvatarPanel();
  $('#entry-title').addEventListener('input',markDirty);$('#entry-status').addEventListener('change',markDirty);$('#entry-tags').addEventListener('input',markDirty);$('#entry-body').addEventListener('input',markDirty);$('#entry-parent')?.addEventListener('change',markDirty);$('#entry-order')?.addEventListener('input',markDirty);document.querySelectorAll('[data-field]').forEach(el=>el.addEventListener('input',markDirty));document.querySelectorAll('.custom-row input').forEach(el=>el.addEventListener('input',markDirty));document.querySelectorAll('.remove-custom').forEach(el=>el.onclick=()=>{el.closest('.custom-row').remove();markDirty();});$('#add-field').onclick=()=>{const box=document.createElement('div');box.innerHTML=customRow('','');const row=box.firstElementChild;$('#custom-fields').append(row);row.querySelectorAll('input').forEach(i=>i.addEventListener('input',markDirty));row.querySelector('button').onclick=()=>{row.remove();markDirty();};row.querySelector('input').focus();};$('#save-now').onclick=flushSave;$('#trash-entry')?.addEventListener('click',trashEntry);$('#restore-entry')?.addEventListener('click',restoreEntry);$('#download-draft')?.addEventListener('click',downloadDraft);$('#reload-entry')?.addEventListener('click',reloadEntry);$('#upload-image').onclick=()=>$('#image-file').click();$('#image-file').onchange=uploadImage;$('#remove-image')?.addEventListener('click',()=>{S.current.image=null;$('#image-preview').textContent='✧';$('#remove-image').remove();markDirty();});$('#edit-tab').onclick=()=>switchPreview(false);$('#preview-tab').onclick=()=>switchPreview(true);$('#add-link').onclick=addLink;renderLinks();renderBacklinks();
  $('#remove-image')?.addEventListener('click',updateAvatarPanel);
  $('#entry-title').addEventListener('input',()=>{const picture=$('#editor .avatar-frame img');if(picture)picture.alt=`Изображение: ${$('#entry-title').value}`;});
}
function customRow(key,value){return `<div class="custom-row"><input class="custom-key" value="${escapeHtml(key)}" placeholder="Название поля" maxlength="80"><input class="custom-value" value="${escapeHtml(value)}" placeholder="Значение"><button class="icon-button remove-custom" title="Удалить поле">×</button></div>`;}
function renderLinks(){const chips=$('#links'),select=$('#link-select');if(!chips||!select)return;const linked=S.current.links||[];chips.replaceChildren();for(const id of linked){const target=S.data.entries.find(x=>x.id===id);const chip=document.createElement('span');chip.className='chip';chip.textContent=target?.title||`Запись ${id.slice(0,8)}`;const remove=document.createElement('button');remove.textContent='×';remove.title='Убрать связь';remove.onclick=()=>{S.current.links=linked.filter(x=>x!==id);renderLinks();markDirty();};chip.append(remove);chips.append(chip);}select.replaceChildren();const options=S.data.entries.filter(x=>!x.deleted&&x.id!==S.current.id&&!linked.includes(x.id)).sort((a,b)=>a.title.localeCompare(b.title,'ru'));const blank=document.createElement('option');blank.value='';blank.textContent=options.length?'Выберите запись':'Нет доступных записей';select.append(blank);for(const e of options){const option=document.createElement('option');option.value=e.id;option.textContent=`${KIND[e.kind].label}: ${e.title}`;select.append(option);}}
function renderBacklinks(){
  const incoming=S.data.entries.filter(x=>!x.deleted&&x.id!==S.current.id&&(x.links||[]).includes(S.current.id));
  if(!incoming.length)return;
  const box=document.createElement('div');box.style.marginTop='19px';
  const heading=document.createElement('h3');heading.textContent='На эту запись ссылаются';box.append(heading);
  const list=document.createElement('div');list.className='link-list';box.append(list);
  for(const entry of incoming){const button=document.createElement('button');button.className='chip';button.textContent=entry.title;button.onclick=()=>selectEntry(entry.id);list.append(button);}
  $('#links').parentElement.append(box);
}
function addLink(){const value=$('#link-select').value;if(!value)return;S.current.links=[...(S.current.links||[]),value];renderLinks();markDirty();}
function collectEntry(){const entry=structuredClone(S.current);entry.title=$('#entry-title').value.trim();entry.status=$('#entry-status').value;entry.tags=$('#entry-tags').value.split(',').map(x=>x.trim()).filter(Boolean);entry.body=$('#entry-body').value;entry.parent_id=$('#entry-parent')?.value||null;entry.order=Number($('#entry-order')?.value||0);entry.fields={};document.querySelectorAll('[data-field]').forEach(el=>entry.fields[el.dataset.field]=el.value);document.querySelectorAll('.custom-row').forEach(row=>{const key=row.querySelector('.custom-key').value.trim();if(key)entry.fields[key]=row.querySelector('.custom-value').value;});return entry;}
function markDirty(){S.dirty=true;S.editVersion++;status('Есть несохранённые изменения','pending');if(!S.conflict){clearTimeout(S.timer);S.timer=setTimeout(()=>savePending(),900);}}
async function savePending(){clearTimeout(S.timer);if(S.conflict)return false;if(S.saving){const result=await S.saving;if(!result)return false;return S.dirty?savePending():true;}if(!S.dirty||!S.current)return true;const entry=collectEntry();if(!entry.title){status('Укажите название','error');return false;}const version=S.editVersion,id=S.current.id;status('Сохранение…','pending');const task=(async()=>{try{const result=await api(`/api/entry/${id}`,'PUT',{entry,revision:S.revision});S.revision=result.revision;if(version===S.editVersion){S.current=result.entry;S.dirty=false;status('Все изменения сохранены');}else{status('Есть несохранённые изменения','pending');clearTimeout(S.timer);S.timer=setTimeout(()=>savePending(),450);}await refreshIndex();return true;}catch(error){if(error.status===409){S.conflict=true;$('#conflict-banner')?.classList.remove('hidden');}status(error.message,'error');showToast(error.message,true);return false;}})();const pending=task.finally(()=>{if(S.saving===pending)S.saving=null;});S.saving=pending;return await pending;}
async function flushSave(){clearTimeout(S.timer);return savePending();}
async function refreshIndex(){if(!S.data)return;const view=S.view,selected=S.selected;S.data=await api('/api/project');S.view=view;S.selected=selected;renderShell();if(view==='dashboard')renderDashboard();else renderList();}
async function newEntry(forcedKind){if(!await flushSave())return;let kind=forcedKind||((S.view in KIND)?S.view:null);if(!kind){const choice=await chooseKind();if(!choice)return;kind=choice;}try{const result=await api('/api/entry','POST',{kind,title:`Новая запись — ${KIND[kind].label}`,body:'',fields:{},status:'Черновик'});await refreshIndex();S.view=kind;S.selected=null;S.current=null;renderShell();renderView();await selectEntry(result.entry.id);$('#entry-title').focus();$('#entry-title').select();}catch(e){showToast(e.message,true);}}
async function importMarkdown(){const file=$('#import-file').files?.[0];$('#import-file').value='';if(!file)return;if(file.size>1_000_000){showToast('Файл больше 1 МБ. Разделите его на несколько записей.',true);return;}if(!await flushSave())return;let kind=(S.view in KIND)?S.view:null;if(!kind){kind=await chooseKind();if(!kind)return;}try{const body=await file.text();const title=file.name.replace(/\.(md|txt)$/i,'').slice(0,160)||'Импортированная запись';const result=await api('/api/entry','POST',{kind,title,body,fields:{},status:'Черновик'});await refreshIndex();S.view=kind;S.selected=null;S.current=null;renderShell();renderView();await selectEntry(result.entry.id);showToast('Файл импортирован как новая запись');}catch(e){showToast(e.message,true);}}
function chooseKind(){return new Promise(resolve=>{openModal('Новая запись',`<p>Выберите, что хотите добавить в мир.</p><div class="kind-choices">${Object.entries(KIND).map(([key,x])=>`<button class="secondary-button" data-kind="${key}" style="margin:4px">${x.icon} ${x.label}</button>`).join('')}</div>`,[{label:'Отмена',className:'quiet-button',onClick:()=>{closeModal();resolve(null);}}]);document.querySelectorAll('[data-kind]').forEach(b=>b.onclick=()=>{closeModal();resolve(b.dataset.kind);});});}
function switchPreview(show){$('#body-preview').classList.toggle('hidden',!show);$('#entry-body').classList.toggle('hidden',show);$('#preview-tab').classList.toggle('active',show);$('#edit-tab').classList.toggle('active',!show);if(show)$('#body-preview').innerHTML=renderMarkdown($('#entry-body').value);}
function inlineMarkdown(text){return escapeHtml(text).replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>').replace(/`([^`]+)`/g,'<code>$1</code>');}
function renderMarkdown(text){if(!text.trim())return '<p class="placeholder">Пока нет описания.</p>';return text.split(/\r?\n/).map(line=>{const match=line.match(/^(#{1,3})\s+(.+)$/);if(match){const n=match[1].length;return `<h${n}>${inlineMarkdown(match[2])}</h${n}>`;}if(/^\s*[-*]\s+/.test(line))return `<p>• ${inlineMarkdown(line.replace(/^\s*[-*]\s+/,''))}</p>`;if(!line.trim())return '<br>';return `<p>${inlineMarkdown(line)}</p>`;}).join('');}
async function prepareAvatarPng(file){
  const bitmap=await createImageBitmap(file);
  try{
    if(bitmap.width*bitmap.height>24_000_000)throw new Error('Разрешение изображения слишком велико. Уменьшите его перед загрузкой.');
    const source=document.createElement('canvas');source.width=bitmap.width;source.height=bitmap.height;
    const context=source.getContext('2d',{willReadFrequently:true});context.drawImage(bitmap,0,0);
    const {data}=context.getImageData(0,0,bitmap.width,bitmap.height),width=bitmap.width,height=bitmap.height;
    const corners=[0,width-1,(height-1)*width,height*width-1].map(i=>i*4);
    const transparent=corners.some(i=>data[i+3]<250);
    const white=!transparent&&corners.every(i=>data[i]>=245&&data[i+1]>=245&&data[i+2]>=245);
    let left=width,top=height,right=-1,bottom=-1;
    if(transparent||white){
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const i=(y*width+x)*4;
        const filled=transparent?data[i+3]>8:data[i+3]>8&&(data[i]<245||data[i+1]<245||data[i+2]<245);
        if(filled){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);}
      }
    }
    if(right<left){left=0;top=0;right=width-1;bottom=height-1;}
    left=Math.max(0,left-2);top=Math.max(0,top-2);right=Math.min(width-1,right+2);bottom=Math.min(height-1,bottom+2);
    const cropWidth=right-left+1,cropHeight=bottom-top+1;
    const scale=Math.min(1,1600/Math.max(cropWidth,cropHeight));
    if(left===0&&top===0&&cropWidth===width&&cropHeight===height&&scale===1)return file;
    const result=document.createElement('canvas');result.width=Math.max(1,Math.round(cropWidth*scale));result.height=Math.max(1,Math.round(cropHeight*scale));
    result.getContext('2d').drawImage(source,left,top,cropWidth,cropHeight,0,0,result.width,result.height);
    const blob=await new Promise(resolve=>result.toBlob(resolve,'image/png'));
    if(!blob)throw new Error('Не удалось подготовить PNG.');
    if(blob.size>12*1024*1024)throw new Error('После обработки изображение больше 12 МБ. Уменьшите его перед загрузкой.');
    return blob;
  }finally{bitmap.close();}
}
async function uploadImage(){
  const input=$('#image-file'),file=input.files?.[0];input.value='';
  if(!file)return;
  if(file.type&&file.type!=='image/png'){showToast('Выберите изображение PNG.',true);return;}
  if(file.size>12*1024*1024){showToast('Изображение больше 12 МБ.',true);return;}
  try{
    const prepared=await prepareAvatarPng(file);
    const buffer=await prepared.arrayBuffer(),bytes=new Uint8Array(buffer);let binary='';
    for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    const result=await api('/api/image','POST',{name:file.name,data:btoa(binary)});
    S.current.image=result.asset;
    $('#image-preview').innerHTML=`<img src="/asset/${result.asset}?token=${encodeURIComponent(token)}" alt="Изображение записи">`;
    if(!$('#remove-image')){
      const button=document.createElement('button');button.id='remove-image';button.className='small-link';button.textContent='Убрать из записи';
      button.onclick=()=>{S.current.image=null;$('#image-preview').textContent='✧';button.remove();updateAvatarPanel();markDirty();};
      $('#upload-image').after(button);
    }
    updateAvatarPanel();markDirty();showToast('Изображение добавлено');
  }catch(error){showToast(error.message,true);}
}
async function trashEntry(){if(!await flushSave())return;openModal('Переместить в корзину?',`<p>«${escapeHtml(S.current.title)}» исчезнет из оглавления, но файл останется в проекте. Запись можно восстановить.</p>`,[{label:'Отмена',className:'quiet-button',onClick:closeModal},{label:'В корзину',className:'danger-button',onClick:async()=>{try{await api(`/api/entry/${S.current.id}/trash`,'POST',{revision:S.revision});closeModal();S.selected=null;S.current=null;await refreshIndex();renderView();showToast('Запись перемещена в корзину');}catch(e){showToast(e.message,true);}}}]);}
async function restoreEntry(){try{const result=await api(`/api/entry/${S.current.id}/restore`,'POST',{revision:S.revision});S.current=result.entry;S.revision=result.revision;await refreshIndex();renderEditor();showToast('Запись восстановлена');}catch(e){showToast(e.message,true);}}
function downloadDraft(){const data=collectEntry();const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`worldatlas-draft-${data.id.slice(0,8)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);}
async function reloadEntry(){if(S.dirty){openModal('Загрузить версию с диска?',`<p>Текущие несохранённые правки исчезнут. Сначала можно скачать их отдельным файлом.</p>`,[{label:'Скачать правки',className:'secondary-button',onClick:downloadDraft},{label:'Отмена',className:'quiet-button',onClick:closeModal},{label:'Загрузить с диска',className:'danger-button',onClick:async()=>{closeModal();await loadEntryFresh();}}]);}else await loadEntryFresh();}
async function loadEntryFresh(){try{const result=await api(`/api/entry/${S.current.id}`);S.current=result.entry;S.revision=result.revision;S.dirty=false;S.conflict=false;await refreshIndex();renderEditor();status('Все изменения сохранены');}catch(e){showToast(e.message,true);}}
function openModal(title,body,actions=[]){$('#modal-title').textContent=title;$('#modal-body').innerHTML=body;const box=$('#modal-actions');box.replaceChildren();for(const action of actions){const b=document.createElement('button');b.className=action.className||'secondary-button';b.textContent=action.label;b.onclick=action.onClick;box.append(b);}$('#modal').classList.remove('hidden');}
function closeModal(){$('#modal').classList.add('hidden');}
function openImageLightbox(source,description){
  const image=$('#lightbox-image');image.src=source;image.alt=description;
  $('#image-lightbox').classList.remove('hidden');
  $('#lightbox-close').focus();
}
function closeImageLightbox(){
  if($('#image-lightbox').classList.contains('hidden'))return;
  $('#image-lightbox').classList.add('hidden');
  $('#lightbox-image').removeAttribute('src');
  $('#editor .avatar-frame')?.focus();
}
function showAppSettings(){
  let selected=S.settings.theme;
  const body=`<p>Оформление применяется ко всем мирам на этом устройстве.</p><div class="theme-choices"><button class="theme-choice ${selected==='modern'?'selected':''}" data-theme-choice="modern" type="button"><span class="theme-swatch swatch-modern"><span></span><span></span></span><strong>Базовое</strong><small>Тёмное, спокойное, с бирюзовыми акцентами</small></button><button class="theme-choice ${selected==='fantasy'?'selected':''}" data-theme-choice="fantasy" type="button"><span class="theme-swatch swatch-fantasy"><span></span><span></span></span><strong>Средневековое / фэнтези</strong><small>Пергамент, тёмное дерево и золото</small></button></div><label class="avatar-setting" for="avatars-enabled"><span><strong>Аватары</strong><small>Показывать изображение рядом с редактором записи</small></span><input id="avatars-enabled" type="checkbox" role="switch" ${S.settings.avatars_enabled?'checked':''}></label>`;
  openModal('Настройки приложения',body,[{label:'Отмена',className:'quiet-button',onClick:closeModal},{label:'Применить',className:'primary-button',onClick:async()=>{try{const settings=await api('/api/settings','PUT',{theme:selected,avatars_enabled:$('#avatars-enabled').checked});S.settings=settings;document.body.dataset.theme=settings.theme;updateAvatarPanel();closeModal();showToast('Настройки приложения сохранены');}catch(error){showToast(error.message,true);}}}]);
  document.querySelectorAll('[data-theme-choice]').forEach(button=>button.onclick=()=>{selected=button.dataset.themeChoice;document.querySelectorAll('[data-theme-choice]').forEach(choice=>choice.classList.toggle('selected',choice===button));});
}
function renderProjectSettings(){
  const p=S.data.project,setup=p.setup_complete===false;
  const genre=GENRES.includes(p.genre)?p.genre:p.genre?'custom':'';
  $('#project-settings').innerHTML=`<div class="settings-heading"><div class="eyebrow">${setup?'ПЕРВЫЙ ШАГ':'ПАСПОРТ МИРА'}</div><h1>Настройки проекта</h1><p>${setup?'Расскажите немного о новом мире. Все поля можно оставить пустыми и заполнить позже.':'Общая информация о мире. Её можно изменить в любой момент.'}</p></div><form id="project-settings-form" class="settings-form"><div class="settings-card"><h2>Основная информация</h2><div class="field"><label for="project-title">Название мира</label><input id="project-title" maxlength="160" value="${escapeHtml(setup?'':p.title)}" placeholder="${escapeHtml(p.title)}"></div><div class="field"><label for="project-summary">Описание</label><textarea id="project-summary" rows="5" maxlength="20000" placeholder="О чём этот мир, какие темы и идеи в нём важны?">${escapeHtml(p.summary||'')}</textarea></div></div><div class="settings-card"><h2>Направление</h2><div class="settings-fields"><div class="field"><label for="project-genre">Общий жанр</label><select id="project-genre"><option value="">Не выбран</option>${GENRES.map(x=>`<option value="${escapeHtml(x)}" ${genre===x?'selected':''}>${escapeHtml(x)}</option>`).join('')}<option value="custom" ${genre==='custom'?'selected':''}>Свой вариант…</option></select><input id="project-genre-custom" class="${genre==='custom'?'':'hidden'}" maxlength="100" value="${escapeHtml(genre==='custom'?p.genre:'')}" placeholder="Введите жанр"></div><div class="field"><label for="project-medium">Формат проекта</label><input id="project-medium" maxlength="100" value="${escapeHtml(p.medium||'')}" placeholder="Игра, книга, сценарий…"></div></div><div class="field"><label for="project-tone">Тон и атмосфера</label><input id="project-tone" maxlength="160" value="${escapeHtml(p.tone||'')}" placeholder="Например, светлое приключение или мрачная сказка"></div></div><div class="settings-footer"><div><span class="settings-path">${escapeHtml(S.data.path)}</span><small>Данные сохраняются в worldatlas.json в папке проекта.</small></div><button id="project-save" type="submit" class="primary-button">${setup?'Сохранить и перейти к миру':'Сохранить настройки'}</button></div></form>`;
  S.projectSettingsDirty=false;
  const form=$('#project-settings-form');
  form.addEventListener('input',()=>{S.projectSettingsDirty=true;status('Есть несохранённые изменения','pending');});
  form.addEventListener('change',()=>{S.projectSettingsDirty=true;status('Есть несохранённые изменения','pending');});
  $('#project-genre').addEventListener('change',()=>{$('#project-genre-custom').classList.toggle('hidden',$('#project-genre').value!=='custom');if($('#project-genre').value==='custom')$('#project-genre-custom').focus();});
  form.onsubmit=e=>{e.preventDefault();saveProjectSettings();};
}
async function saveProjectSettings(navigate=true){
  if(S.view!=='project_settings')return true;
  const setup=S.data.project.setup_complete===false;
  if(!S.projectSettingsDirty&&!setup){if(navigate)showToast('Настройки уже сохранены');return true;}
  const genre=$('#project-genre').value;
  const project={title:$('#project-title').value,summary:$('#project-summary').value,genre:genre==='custom'?$('#project-genre-custom').value:genre,medium:$('#project-medium').value,tone:$('#project-tone').value};
  const button=$('#project-save');button.disabled=true;status('Сохранение…','pending');
  try{const result=await api('/api/project','PUT',{project,revision:S.data.project_revision});S.data.project=result.project;S.data.project_revision=result.revision;S.projectSettingsDirty=false;status('Все изменения сохранены');if(setup&&navigate)S.view='dashboard';renderShell();renderView();showToast(setup?'Мир готов к работе':'Настройки проекта сохранены');return true;}
  catch(error){status(error.message,'error');showToast(error.message,true);button.disabled=false;return false;}
}
async function createBackup(){if(S.projectSettingsDirty&&!await saveProjectSettings(false))return;if(!await flushSave())return;try{const result=await api('/api/backup','POST',{});showToast(`Резервная копия создана: ${result.path}`);}catch(e){showToast(e.message,true);}}
async function quitApp(){if(S.projectSettingsDirty&&!await saveProjectSettings(false))return;if(!await flushSave())return;openModal('Закрыть приложение?',`<p>Все сохранённые файлы останутся в папке проекта.</p>`,[{label:'Отмена',className:'quiet-button',onClick:closeModal},{label:'Закрыть',className:'primary-button',onClick:async()=>{try{await api('/api/quit','POST',{});document.body.innerHTML='<div class="empty-editor"><div class="empty-symbol">✦</div><h2>Атлас миров закрыт</h2><p>Можно закрыть эту вкладку.</p></div>';}catch(e){showToast(e.message,true);}}}]);}

init();

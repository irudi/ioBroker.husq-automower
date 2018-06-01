/*
 *
 *      ioBroker Husqvarna Automower Adapter
 *
 *      (c) 2018 Greyhound <truegreyhound@gmx.net>
 *
 *      MIT License
 *
 */


/* jshint -W097 */ // jshint strict:false
/*jslint node: true */
"use strict";

//!V! 0.3.3.0

//!I! in den Husqvarna-GPS-Daten fehlt Zeitstempel!
//!I! Adapter setzt voraus, dass Mower spätestens Mitternacht eingeparkt hat

//!P! Wenn husq-automower.1.info.connected === false --> Alarm --> Stromausfall, gekappt oder geklaut

//!P! Mäher angehoben --> Alarm-Message

//!P! mWaitAfterRainTimer is not used !?
//!P! mWaitAutoTimer is not used !?
//!P! dpAutoTimerWatch anzeigen

//!P! in config button to test connection data and fill Combobox to select a mower, on one, fill direct

//!P! kurz vor Autostart mower (wie auslesen, sonst manuell eintragen) prüfen ob Regen, wenn ja, dann mower stop

//!P! mover.isCutting scheint nicht gesetzt zu werden!?

//!P! es scheint einen Befehl "Pause" zu geben, unklar ist zumindest, wie der Status Pause entsteht und ob Pause bedeutet auf aktueller Position bleiben oder Pause in Ladestation
//!P! Wenn Mower in Status Pause wechselt, prüfen, ob in Ladestation (GPS + Abweichung, Druckschalter (in Arbeit), ???), Wenn nicht, dann Telegram-Nachricht und nach Zeit XXX automatisch parken lassen ?!
//!P! Druckschalter an Raspberry anschließen, der erkennt, ob Mower in Ladestation
//!P! Wenn Druckschalter anspricht und letzter Status != LEAVING und altueller Status != CUTTING (testen!) --> ALARM

//!P! via einem Scheduler (setInterval) prüfen, dass Status etc. aktualisiert wird, wenn nicht bzw. http-Fehler oder sich trotz CUTTING GPS-Daten nicht ändern --> ALARM

//!P! Batteriekapazität überwachen, wenn unter xx (10% ?) sinkt, Alarm per telegramm

//!P! Wenn Mower geparkt, dann Timer programmieren ermöglichen, der Mower wieder startet

//!P! Wenn Mower durch Regenfunktion geparkt, prüfen, warum restart nicht klappt

//!P! Regentaste, wenn gedrückt den Mäher parken und erst wieder starten, wenn Regentimer den Start wieder freigibt
//!P! Taste wirkt // zum "Regensensor"

//!P! idnStoppedDueRain
//!P! - gesetzt durch forecast
//!P! - gesetzt durch Regensensor

//!P! "Pause"-Taste --> mower parken, startet Timer mit einstellbarer Zeit (oder jeder Pausendruck erhöht Pausenwert um X), nach Ablaus geht Mower wieder in Normalbetrieb

//!P! Es gibt wohl noch weitere Befehle ?? add_push_id, remove_push_id <-- ggf. nur für iOS/Android; geo_status, get_mower_settings

//!P! Idee, Wenn Cutting und bei den letzten 2 Statusabfragen keine Änderung des Standortes wahrscheinlich Fehler oder?

/*
Handy-App
- sollte Mähdauer anzeigen und wahrscheinlich nächsten Boxenstop
- letzte Datenaktualisierung
- Akkustatus (% Kapazität) beim Mähen anzeigen, wird jetzt angezeigt
- bei bestimmten Fehlern (hängt fest), sollte ein Start per App möglich sein
- Mäher hatte Netzverbindung verloren, via App nicht erkennbar, es fehlt Datum/Uhrzeit letzte Aktualisierung vom Mäher
- Datum/Uhrzeit == lokale Zeit ???
- Rückmeldung Mähen erforderlich (Mähwiderstand)
- Rückmeldung aktiver Mähbereich
- bei Statusänderung sollte der Auslöser "festgehalten" werden: mower timer, App + account, via Web-API + account
*/

/*
Actions
- Start
- Park
- Stop


*/

/*
Status
- OFF_HATCH_OPEN
- OFF_HATCH_CLOSED_DISABLED - deaktiviert, manueller Start erforderlich
- OK_CHARGING
- OK_CUTTING
- OK_CUTTING_NOT_AUTO
- OK_LEAVING
- OK_SEARCHING
- PARKED_AUTOTIMER
- OFF_DISABLED
- ERROR
- PARKED_PARKED_SELECTED
- PARKED_TIMER
- PAUSED

ErrorCodes
 2 - kein Schleifensignal, Mower fährt aber weiter, unkritisch
13 - kein Antrieb
25 - Mäheinheit ist blockiert
69 - ????
71 - Mäher angehoben

next start source
- MOWER_CHARGING
- NO_SOURCE
- COMPLETED_CUTTING_TODAY_AUTO --> nextStartTimestamp --> 2017-07-07 02:00:00
- WEEK_TIMER --> nextStartTimestamp --> 2017-07-07 02:00:00

OperatingMode
- Auto
- HOME --> PARKED_PARKED_SELECTED

*/


// you have to require the utils module and call adapter function
const utils = require(__dirname + '/lib/utils'); // Get common adapter utils
// you have to call the adapter function and pass a options object
// name has to be set and has to be equal to adapters folder name and main file name excluding extension
// adapter will be restarted automatically every time as the configuration changed, e.g system.adapter.template.0
const adapter = utils.Adapter('husq-automower');

const HusqApiRequest = require(__dirname + '/lib/HusqApiRequest');
const husqApi = new HusqApiRequest(adapter);
const husqSchedule = require('node-schedule');

const idnMowerConnected = 'info.connected',
    idnMowerFirmware = 'info.firmware',
    idnMowerNickname = 'info.nickname',
    idnMowerID = 'info.mower_id',
    idnMowerModel = 'info.model',
    idnMowersIndex = 'info.mowers_index',
    idnMowersJson = 'info.mowers_json',

    idnHomeLocationName = 'mower.homeLocation.name',
    idnHomeLocationLongitude = 'mower.homeLocation.longitude',
    idnHomeLocationLatitude = 'mower.homeLocation.latitude',
    idnHomeLocationLongitudeCP = 'mower.homeLocation.longitudeCP',      // CP == Husqvarna central point record
    idnHomeLocationLatitudeCP = 'mower.homeLocation.latitudeCP',
    idnHomeLocationLongitudeOffset = 'mower.homeLocation.longitudeOffset',
    idnHomeLocationLatitudeOffset = 'mower.homeLocation.latitudeOffset',
    idnHomeLocationCurrentDistance = 'mower.homeLocation.currentDistance',
    idnHomeLocationMaxDistance = 'mower.homeLocation.maxDistance',
    idnHomeLocationSensitivityLevel = 'mower.homeLocation.sensitivityLevel',
    idnHomeLocationSensitivityRadius = 'mower.homeLocation.sensitivityRadius',

    idnLastLocationLatitude = 'mower.lastLocation.latitude',
    idnLastLocationLongitude = 'mower.lastLocation.longitude',
    idnLastLocationTimestamp = 'mower.lastLocation.timestamp',

    idnBatteryChargeCycleDaily = 'mower.statistics.batteryChargeCycleDaily',
    idnBatteryEfficiencyFactor = 'mower.statistics.batteryEfficiencyFactor',
    idnChargingStartTime = 'mower.statistics.chargingBatteryStarttime',
    idnChargingTimeBatteryCurrent = 'mower.statistics.chargingTimeBatteryCurrent',
    idnChargingTimeBatteryDaily = 'mower.statistics.chargingTimeBatteryDaily',
    idnChargingTimeBatteryNew = 'mower.statistics.chargingTimeBatteryNew',
    idnCurrentCoveredDistance = 'mower.statistics.currentCoveredDistance',
    idnCoveredDistanceDaily = 'mower.statistics.coveredDistanceDaily',
    idnLastMowingTime = 'mower.statistics.lastMowingTime',
    idnLastCoveredDistance = 'mower.statistics.lastCoveredDistance',
    idnLastStationReturnTime = 'mower.statistics.lastStationReturnTime',
    idnMowingTime = 'mower.statistics.mowingTime',
    idnMowingTimeDaily = 'mower.statistics.mowingTimeDaily',
    idnMowingStartTime = 'mower.statistics.mowingStartTime',
    idnMowingTimeBatteryNew = 'mower.statistics.mowingTimeBatteryNew',
    idnOverallBatteryChargeCycle = 'mower.statistics.overallBatteryChargeCycle',
    idnOverallMowingTime = 'mower.statistics.overallMowingTime',
    idnOverallCoveredDistance = 'mower.statistics.overallCoveredDistance',

    idnAMAction = 'mower.action',
    idnBatteryPercent = 'mower.batteryPercent',
    idnCurrentErrorCode = 'mower.currentErrorCode',
    idnCurrentErrorCodeTS = 'mower.currentErrorCodeTimestamp',
    idnLastAction = 'mower.lastAction',
    idnLastDockingTime = 'mower.lastDockingTime',
    idnLastErrorCode = 'mower.lastErrorCode',
    idnLastErrorCodeTS = 'mower.lastErrorCodeTimestamp',
    idnLastHttpStatus = 'mower.lastHttpStatus',
    idnLastLocations = 'mower.lastLocations',
    idnLastStatus = 'mower.lastStatus',
    idnLastStatusTime = 'mower.lastStatusTime',
    idnLastStatusChangeTime = 'mower.lastStatusChangeTime',
    idnLastDayLocations = 'mower.lastdayLocations',
    idnNextStartSource = 'mower.nextStartSource',
    idnNextStartTime = 'mower.nextStartTime',        // --> io-package
    idnNextStartWatching = 'mower.nextStartWatching',
    idnOperatingMode = 'mower.operatingMode',
    //idnStopOnRainEnabled = 'mower.stopOnRainEnabled', // --> config
    idnStoppedDueRain = 'mower.stoppedDueRain',
    idnTimerAfterRainStartAt = 'mower.timerAfterRainStartAt',
    //!P! ??idnWaitAfterRain = 'mower.waitAfterRain',
    idnRawSend = 'mower.rawSend',
    idnRawResponse = 'mower.rawResponse',
    idnRawResponseGeo = 'mower.rawResponse_geo',
    idnSendMessage = 'mower.sendMessage',
    UrlGoogleMaps = 'http://maps.google.com/maps?q=',
    ThisIsTheEnd = 'ThisIsTheEnd';


let mobjMower = [],
    mQueryIntervalActive_s = 30,
    mQueryIntervalInactive_s = 300,
    mCurrentStatus = 'unknown',
    mLastStatus = 'unknown',
    mHomeLocationLongitude = 0,
    mHomeLocationLatitude = 0,
    mNextStart = 0,
    mStoppedDueRain = false,
    mLastErrorCode = 0,
    mLastErrorCodeTimestamp = 0,
    mJsonLastLocations = [],
    mDist = 0,
    mDistDaily = 0,
    mMaxDistance = 0,
    mLastLocationLongi = 0,
    mLastLocationLati = 0,
    mBatteryPercent = 0,
    mMowingTime = 0,
    mLastMowingTime = 0,
    mMowingTimeDaily = 0,
    mMowingTimeBatteryNew = 0,
    mStartMowingTime = 0,
    mSearchingStartTime = 0,
    mChargingStartTime = 0,
    mChargingTimeBatteryCurrent = 0,
    mChargingTimeBatteryDaily = 0,
    mChargingTimeBatteryNew = 0,
    mScheduleStatus = null,
    mScheduleTime = 1,
    mTimeZoneOffset = new Date().getTimezoneOffset(),       // offset in minutes
    mWaitAfterRainTimer = null,
    mWaitAutoTimer = null,
    mBatteryChargeCycleDaily = 0,
    mLastStatusChangeTime = 0,
    mScheduleDailyAccumulation = null,
    mWaitAfterRain_m = 0,
    ThisIsTheEnd2;


adapter.on('unload', function (callback) {
    try {
        husqApi.logout();
        if(mScheduleStatus !== null) clearInterval(mScheduleStatus);    //.cancel;
        if(mScheduleDailyAccumulation !== null) mScheduleDailyAccumulation.cancel;

        if (adapter.setState) adapter.setState('info.connection', false, true);

        adapter.log.info('cleaned everything up...');

        callback();
    } catch (e) {
        callback();
    }
});


// is called if a subscribed object changes
adapter.on('objectChange', function (id, obj) {
    // Warning, obj can be null if it was deleted
    adapter.log.info("objectChange " + id + " " + JSON.stringify(obj));
});


/**
 * Function to create a state and set its value
 * only if it hasn't been set to this value before
 * from 'node_modules/iobroker.unifi/main.js'
 */
function createState(name, value, desc, _write, _unit) {

    if(typeof(desc) === 'undefined')
        desc = name;
    if(typeof(_write) === 'undefined')
        _write = false;
    if(typeof(_write) !== 'boolean')
        _write = false;

    if(Array.isArray(value))
        value = value.toString();

    if(typeof(_unit) === 'undefined') {
        adapter.setObjectNotExists(name, {
            type: 'state',
            common: {
                name: name,
                desc: desc,
                type: typeof(value),
                read: true,
                write: _write
            },
            native: {id: name}
        }, function(err, obj) {
            if (!err && obj) {
                if(typeof(value) !== 'undefined') {
                    adapter.setState(name, {
                        val: value,
                        ack: true
                    });
                }
            }
        });
    } else {
        adapter.setObjectNotExists(name, {
            type: 'state',
            common: {
                name: name,
                desc: desc,
                type: typeof(value),
                read: true,
                write: _write,
                unit: _unit
            },
            native: {id: name}
        }, function(err, obj) {
            if (!err && obj) {
                if(typeof(value) !== 'undefined') {
                    adapter.setState(name, {
                        val: value,
                        ack: true
                    });
                }
            }
        });
    }
} // createState(9


function createChannels() {

    const fctName = 'createChannels';
    adapter.log.debug(fctName + ' started');

    adapter.setObjectNotExists('info', {
        type: 'channel',
        role: 'info',
        common: {
            name: 'information',
        },
        native: {}
    }, function(err) {
        if (err) adapter.log.error('Cannot write object: ' + err);
    });

    adapter.setObjectNotExists('mower', {
        type: 'channel',
        role: 'info',
        common: {
            name: 'mower',
        },
        native: {}
    }, function(err) {
        if (err) adapter.log.error('Cannot write object: ' + err);
    });

    adapter.setObjectNotExists('mower.homeLocation', {
        type: 'channel',
        role: 'info',
        common: {
            name: 'mower.homeLocation',
        },
        native: {}
    }, function(err) {
        if (err) adapter.log.error('Cannot write object: ' + err);
    });

    adapter.setObjectNotExists('mower.lastLocation', {
        type: 'channel',
        role: 'info',
        common: {
            name: 'mower.lastLocation',
        },
        native: {}
    }, function(err) {
        if (err) adapter.log.error('Cannot write object: ' + err);
    });

    adapter.setObjectNotExists('mower.statistics', {
        type: 'channel',
        role: 'info',
        common: {
            name: 'mower.statistics',
        },
        native: {}
    }, function(err) {
        if (err) adapter.log.error('Cannot write object: ' + err);
    });

    adapter.log.debug(fctName + ' finished');

} // createChannels()


function createDPs() {

    const fctName = 'createDPs',
        enableJson = adapter.config.enableJson;

    adapter.log.debug(fctName + ' started');

    createState(idnMowerConnected, false);
    createState(idnMowerFirmware, '');
    createState(idnMowerNickname, '');
    createState(idnMowerID, '');
    createState(idnMowerModel, '');
    createState(idnMowersIndex, -1);

    if(enableJson) { createState(idnMowersJson, []); }

    createState(idnHomeLocationName, '', idnHomeLocationName, true);
    createState(idnHomeLocationLongitude, 0, idnHomeLocationLongitude, true);
    createState(idnHomeLocationLatitude, 0, idnHomeLocationLatitude, true);
    createState(idnHomeLocationLongitudeCP, 0);
    createState(idnHomeLocationLatitudeCP, 0);
    createState(idnHomeLocationLongitudeOffset, 0, idnHomeLocationLongitudeOffset, true);
    createState(idnHomeLocationLatitudeOffset, 0, idnHomeLocationLatitudeOffset, true);
    createState(idnHomeLocationCurrentDistance, 0, idnHomeLocationCurrentDistance, false, "m");
    createState(idnHomeLocationMaxDistance, 100, idnHomeLocationMaxDistance, true, "m");
    createState(idnHomeLocationSensitivityLevel, 3);
    createState(idnHomeLocationSensitivityRadius, 1000);

    createState(idnLastLocationLatitude, 0);
    createState(idnLastLocationLongitude, 0);
    createState(idnLastLocationTimestamp, 0);

    createState(idnMowingTime, 0, idnMowingTime, false, "min.");
    createState(idnMowingTimeDaily, 0, idnMowingTimeDaily, false, "min.");
    createState(idnMowingStartTime, 0);
    createState(idnMowingTimeBatteryNew, 0, idnMowingTimeBatteryNew, false, "min.");
    createState(idnBatteryChargeCycleDaily, 0);
    createState(idnBatteryEfficiencyFactor, 0, idnBatteryEfficiencyFactor, false, "%");
    createState(idnChargingStartTime, 0);
    createState(idnChargingTimeBatteryCurrent, 0, idnChargingTimeBatteryCurrent, false, "min.");
    createState(idnChargingTimeBatteryDaily, 0, idnChargingTimeBatteryDaily, false, "min.");
    createState(idnChargingTimeBatteryNew, 0, idnChargingTimeBatteryNew, false, "min.");
    createState(idnCurrentCoveredDistance, 0, idnCurrentCoveredDistance, false, "m");
    createState(idnCoveredDistanceDaily, 0, idnCoveredDistanceDaily, false, "m");
    createState(idnLastMowingTime, 0, idnLastMowingTime, false, "min.");
    createState(idnLastCoveredDistance, 0, idnLastCoveredDistance, false, "m");
    createState(idnLastStationReturnTime, 0, idnLastStationReturnTime, false, "min.");
    createState(idnOverallBatteryChargeCycle, 0);
    createState(idnOverallMowingTime, 0, idnOverallMowingTime, false, "h");
    createState(idnOverallCoveredDistance, 0, idnOverallCoveredDistance, false, "km");

    createState(idnAMAction, 0);
    createState(idnBatteryPercent, 0, idnBatteryPercent, false, "%");
    createState(idnCurrentErrorCode, 0);
    createState(idnCurrentErrorCodeTS, 0);
    createState(idnLastAction, 'unkonwn');
    createState(idnLastDockingTime, 0);
    createState(idnLastErrorCode, 0);
    createState(idnLastErrorCodeTS, 0);
    createState(idnLastHttpStatus, 0);
    createState(idnLastLocations, '[]');
    createState(idnLastStatus, 'unkonwn');
    createState(idnLastStatusTime, 0);
    createState(idnLastStatusChangeTime, 0);
    createState(idnLastDayLocations, '[]');
    createState(idnNextStartSource, '');
    createState(idnNextStartTime, 0);
    createState(idnNextStartWatching, false);
    createState(idnOperatingMode, 'unkonwn');
    //createState(idnStopOnRainEnabled, false, idnStopOnRainEnabled, true);
    createState(idnStoppedDueRain, false, idnStoppedDueRain, true);
    createState(idnTimerAfterRainStartAt, 0);
    createState(idnSendMessage, '');


    //States for testing
    if (enableJson) {
        createState('mower.rawSend', '', 'object for sending raw messages to the mower');
        createState('mower.rawResponse', '', 'Display the raw message from the mower');
        createState(idnRawResponseGeo, '', 'Display the raw message from the mower locations');
    } else {    //delete Teststates
        adapter.deleteState(adapter.namespace, 'mower', 'rawSend');
        adapter.deleteState(adapter.namespace, 'mower', 'rawResponse');
    }

    adapter.log.debug(fctName + ' finished', 'debug2');

} // createDPs()


function createDataStructure(adapter) {

    createChannels();

    createDPs();

} // createDataStructure()


function parseBool(value) {
    if (typeof value === "boolean") return value;

    if (typeof value === "number") {
        return value === 1 ? true : value === 0 ? false : undefined;
    }

    if (typeof value != "string") return undefined;

    return value.toLowerCase() === 'true' ? true : value.toLowerCase() === 'false' ? false : undefined;


} // parseBool()


adapter.on('stateChange', function (id, state) {
    if (state && !state.ack) {
        adapter.log.debug('stateChange, id: ' + id + '; state: ' + JSON.stringify(state));       // ld: husq-automower.0.mower.lastLocation.longitude; state: {"val":11.435046666666667,"ack":false,"ts":1524829008532,"q":0,"from":"system.adapter.husq-automower.0","lc":1524829008532}

        let iddp = id.substr(adapter.namespace.length + 1),
            fctName = '';

        if(id === adapter.config.idRainSensor) {
            // adapter.config.RainSensorValue - [bool, true]
            fctName = 'subscription rainsensor change';
            let bRain = parseBool(state.val),
                sMsg = '',
                vTest = dapter.config.RainSensorValue;

            if(vTest !== '' && typeof vTest === 'object') {
                bRain = (typeof state.val === vTest[0] && state.val === vTest[1]) ? true : false;
            }

            adapter.log.debug(fctName + ',  id: "' + id + '"; state.val: ' + state.val);
            adapter.log.debug(fctName + ', mLastStatus: ' + mLastStatus);

            if(bRain) {
                adapter.setState(idnStoppedDueRain, true, true);
                adapter.log.debug(fctName + ' stopped due rain activated');
            } else {
                adapter.setState(idnStoppedDueRain, false, true);
                adapter.log.debug(fctName + ' stopped due rain deactivated');
            }

            adapter.log.debug(fctName + ' finished', 'debug2');
        }
        else if(id === adapter.config.idWeatherRainForecast) {
            // !P! adapter.config.stopOnRainPercent
            fctName = 'Subscriber rainforcast';
            adapter.log.debug(fctName + ',  id: "' + id + '"; state.val: ' + state.val);
//!P!
            let sMsg = '',
                mRainPercent = getState(idWeatherRainForecastPercent).val,
                mRain1h = getState(idWeatherRainForecast1h).val,
                mRainPercent1h = getState(idWeatherRainForecastPercent1h).val;
            adapter.log.debug(fctName + ', mLastStatus: ' + mLastStatus + ',  stopOnRainPercent: ' + adapter.config.stopOnRainPercent + '; mRainPercent: ' + mRainPercent + ',  mRain1h: ' + mRain1h + ',  mRainPercent1h: ' + mRainPercent1h);

            if (state.val > 0 || (state.val === 0 && mRainPercent > adapter.config.stopOnRainPercent)) {
                adapter.setState(idnStoppedDueRain, true, true);
                adapter.log.debug(fctName + ' idnStoppedDueRain activated', 'debug2');
            }

            if (state.val === 0 && mRainPercent === 0) {
                // no rain in forcast
                if (mWaitAfterRainTimer !== null) {
                    clearTimeout(mWaitAfterRainTimer);

                    adapter.setState(idnTimerAfterRainStartAt, 0, true);
                }

                let timeout = mWaitAfterRain_m * 60 * 1000;          // 7200000
                mWaitAfterRainTimer = setTimeout(startMowerAfterAutoTimerCheck, timeout);

                adapter.setState(idnTimerAfterRainStartAt, new Date().getTime(), true);

                sMsg = fctName + ' changed to no rain; wait ' + mWaitAfterRain_m + ' min. for starting mower';
                adapter.setState(idnSendMessage, JSON.stringify([new Date().getTime(), sMsg, fctName + ' changed', state.val, 1, 'Tg,EL']), true);
            }

            if ((new Date().getTime() - obj.state.ts) / 1000 / 60 > 20) {
                // weather forcast not uptodate ?!
                adapter.log.error(fctName + ' error, last update for "' + idWeatherRainForecast + '" us older then ' + ((new Date().getTime() - obj.state.ts) / 1000 / 60) + ' minutes!');

                //!P! telegram message?
            }

            adapter.log.debug(fctName + ' finished');
        }

        switch (iddp) {
            case idnAMAction:
                fctName = 'subscription mower.action changed';

                if (state.val > 0) {
                    if (state.val === 1) {
                        adapter.log.debug(fctName + ',  start mower');

                        mobjMower.sendCommand(mobjMower.command.start, (err, msg) => {
                            if (err) {
                                adapter.log(msg);
                            } else {
                                adapter.log("Parked the mower");
                            }
                        });
                    } else if (state.val === 2) {
                        adapter.log.debug(fctName + ',  stop mower');

                        mobjMower.sendCommand(mobjMower.command.stop, (err, msg) => {
                            if (err) {
                                adapter.log(msg);
                            } else {
                                adapter.log("Parked the mower");
                            }
                        });
                    } else if (state.val === 3) {
                        adapter.log.debug(fctName + ',  park mower');

                        mobjMower.sendCommand(mobjMower.command.park, (err, msg) => {
                            if (err) {
                                adapter.log(msg);
                            } else {
                                adapter.log("Parked the mower");
                            }
                        });
                    } else if (state.val === 4) {
                        adapter.log.debug(fctName + ',  geostatus');
// !P! ??
                    } else if (state.val === 9) {
                        adapter.log.debug(fctName + ',  status mower');
// !P! ?? --> updateStatus, prüfen ob schedule nicht läuft
                    } else if (state.val === 77) {
                        adapter.log.debug(fctName + ',  toggle rain detected');

                        adapter.getState(idnStoppedDueRain, function (err, stateSDR) {
                            if (!err && stateOCD) {
                                adapter.setState(idnStoppedDueRain, !parseBool(stateSDR.val), true);
                            }
                        });

                    } else if (state.val === 95) {
                        adapter.log.debug(fctName + ',  pause');
// !P! ??
                    } else if (state.val === 96) {
                        adapter.log.debug(fctName + ',  led on/off');
// !P! ??
                    }
                    adapter.setState(idnAMAction, 0, true);
                }
                adapter.log.debug(fctName + ' finished');
                break;

            case idnStoppedDueRain:
                fctName = 'subscrition StoppedDueRain changed';
                adapter.log.debug(fctName + ',  id: "' + idnStoppedDueRain + '"; state.val: ' + state.val);

                let sMsg = '';
                adapter.log.debug(fctName + ' mLastStatus: ' + mLastStatus + ',  adapter.config.stopOnRainEnabled: ' + adapter.config.stopOnRainEnabled);

                if (state.val === true && adapter.config.stopOnRainEnabled === true) {
                    // it's raining
                    if(mLastStatus === 'OK_CUTTING' || mLastStatus === 'OK_CUTTING_NOT_AUTO' || mLastStatus === 'OK_CHARGING') {	// PARKED_PARKED_SELECTED ??
                        mobjMower.sendCommand(mobjMower.command.park, (err, msg) => {
                            if (err) {
                                adapter.log(msg);
                            } else {
                                adapter.log("Parked the mower");
                            }
                        });

                        if (mWaitAfterRainTimer !== null) {
                            clearTimeout(mWaitAfterRainTimer);

                            adapter.setState(idTimerAfterRainStartAt, 0, true);
                        }

                        sMsg = fctName + ' is activated; send mower command "park"';
                        adapter.setState(idnSendMessage, JSON.stringify([new Date().getTime(), sMsg, fctName, state.val, 1, 'Tg,EL']), true);
                    }
                }

                if (state.val === false && adapter.config.stopOnRainEnabled === true) {
                    // rain is over, wait if gras is dry
                    if (mWaitAfterRainTimer !== null) {
                        clearTimeout(mWaitAfterRainTimer);

                        adapter.setState(idTimerAfterRainStartAt, 0, true);
                    }

                    let timeout = mWaitAfterRain_m * 60 * 1000;          // 7200000

                    mWaitAfterRainTimer = setTimeout(startMowerAfterAutoTimerCheck, timeout);

                    adapter.setState(idTimerAfterRainStartAt, new Date().getTime(), true);

                    sMsg = fctName + ' changed to no rain; wait ' + mWaitAfterRain_m + ' min. for starting mower';
                    adapter.setState(idnSendMessage, JSON.stringify([new Date().getTime(), sMsg, fctName + ' changed', state.val, 1, 'Tg,EL']), true);
                }

                adapter.log.debug(fctName + ' finished');

                break;
        }

    }
}); // adapter.on('stateChange')


// Some message was sent to adapter instance over message box. Used by email, pushover, text2speech, ...
adapter.on('message', function (obj) {
    if (typeof obj == 'object' && obj.message) {
        /*        if (obj.command == 'send') {
                    // e.g. send email or pushover or whatever
                    adapter.log.info('send command');

                    // Send response in callback if required
                    if (obj.callback) adapter.sendTo(obj.from, obj.command, 'Message received', obj.callback);
                } */
    }
});


function getDistance(lat1, long1, lat2, long2) {
    // GPS_DISTANCE(lat1 DOUBLE, long1 DOUBLE, lat2 DOUBLE, long2 DOUBLE)
    const fctName = 'getDistance';
    //adapter.log.debug(fctName + ' started' + '; lat1: ' + lat1 + '; long1: ' + long1 + '; lat2: ' + lat2 + '; long2: ' + long2);

    let R = 6371, // Radius of the earth in km
        dLat = (lat2 - lat1) * Math.PI / 180,  // deg2rad below
        dLon = (long2 - long1) * Math.PI / 180,
        a = 0.5 - Math.cos(dLat)/2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * (1 - Math.cos(dLon))/2,

        dist = R * 2 * Math.asin(Math.sqrt(a)) * 1000;  // m

    //adapter.log.debug(fctName + ' finished; dist: ' + dist);

    return dist;

} // getDistance()


function checkAMatHome(lat2, long2) {
    // GPS_DISTANCE(lat1 DOUBLE, long1 DOUBLE, lat2 DOUBLE, long2 DOUBLE)
    const fctName = 'checkAMatHome';
    adapter.log.debug(fctName + ' started' + '; lat2: ' + lat2 + '; long2: ' + long2);
    adapter.log.debug(fctName + ' mHomeLocationLatitude: ' + mHomeLocationLatitude + '; mHomeLocationLongitude: ' + mHomeLocationLongitude + '; mMaxDistance: ' + mMaxDistance);

    if(mHomeLocationLatitude === 0 || mHomeLocationLongitude === 0) {
        adapter.log.warn(fctName + ' >> homeLocation.latitude and/or homeLocation.longitude not set or failure on reading!');

        return;
    }

    let R = 6371, // Radius of the earth in km
        dLat = (lat2 - mHomeLocationLatitude) * Math.PI / 180,  // deg2rad below
        dLon = (long2 - mHomeLocationLongitude) * Math.PI / 180,
        a = 0.5 - Math.cos(dLat)/2 + Math.cos(mHomeLocationLatitude * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * (1 - Math.cos(dLon)) / 2,
        dist = R * 2 * Math.asin(Math.sqrt(a)) * 1000;

    adapter.setState(idnHomeLocationCurrentDistance, Math.round(dist));
    //let dist = Math.acos(Math.sin(degrees_to_radians(mHomeLocationLatitude)) * Math.sin(degrees_to_radians(lat2)) + Math.cos(degrees_to_radians(mHomeLocationLatitude)) * Math.cos(degrees_to_radians(lat2)) * Math.cos(degrees_to_radians(long2) - degrees_to_radians(mHomeLocationLongitude))) * 6371 * 1000;

    if (dist > mMaxDistance) {
        // alarm
        adapter.log.error(fctName + ' dist > mMaxDistance: ' + dist - mMaxDistance);

        adapter.setState(idnSendMessage, JSON.stringify([new Date().getTime(), 'max disctance exceeded\r\ncurrent position ' + UrlGoogleMaps + lat2 + ',' + long2, 'mower state changed', Math.round(dist) + ' m', 3, 'Tg,Ma,EL']), true);
    }

    adapter.log.debug(fctName + ' finished; dist: ' + dist);

} // checkAMatHome()


function createStatusScheduler() {
    const fctName = 'createStatusScheduler';
    adapter.log.debug(fctName + ' started');

    if(mScheduleStatus !== null) {
        //clearSchedule(mScheduleStatus);
        //mScheduleStatus.cancel;
        clearInterval(mScheduleStatus);

        mScheduleStatus = null;
    }

    if (isNaN(mScheduleTime) || mScheduleTime < 31) {
        mScheduleTime = 60;
    }

    mScheduleStatus = setInterval(updateStatus, mScheduleTime * 1000);

    //mScheduleStatus = husqSchedule.scheduleJob('*/' + (mScheduleTime * 1000) + ' * * * * *', function () {
    //    updateStatus();
    //});
    adapter.log.debug(fctName + ' finished');

} // createStatusScheduler()


function startMowerAfterAutoTimerCheck() {
    const fctName = 'startMowerAfterAutoTimerCheck';
    adapter.log.debug(fctName + ' started');

//!P! ?? welcher Status noch?
    if(mCurrentStatus === 'PARKED_AUTOTIMER' || mCurrentStatus !== 'PARKED_PARKED_SELECTED' || mCurrentStatus !== 'PARKED_TIMER') {
        mobjMower.sendCommand(mobjMower.command.start, (err, msg) => {
            if (err) {
                adapter.log(msg);
            } else {
                adapter.log('Parked the mower');
            }
        });

        adapter.log.debug(fctName + '; mower started');
    }

    mWaitAutoTimer = null;
    adapter.setState(idnNextStartWatching, false, true);

    adapter.log.debug(fctName + ' finished');

} // startMowerAfterAutoTimerCheck()


function dailyAccumulation(bCheck) {
    const fctName = 'dailyAccumulation';

    if(typeof(bCheck) === 'undefined')
        bCheck = false;

    adapter.log.debug(fctName + ' started');

    adapter.log.debug(fctName + '; stop status timer');
    // stop status timer
    if(mScheduleStatus !== null) {
        //clearSchedule(mScheduleStatus);
        //mScheduleStatus.cancel;
        clearInterval(mScheduleStatus);

        mScheduleStatus = null;
    }

    adapter.log.debug(fctName + '; add current covered distance to overall distance ...');
    // add current covered distance to overall distance in km
    adapter.getState(idnCoveredDistanceDaily, function (errCDD, stateCDD) {
        if (!errCDD && stateCDD) {
            adapter.log.debug(fctName + '; add current covered distance; bCheck: ' + bCheck + '; stateCDD.ts: ' + stateCDD.ts + '; new Date(00): ' + (new Date().setHours(0, 0, 0, 0)) + '; stateCDD.val: ' + stateCDD.val);
            if(bCheck === false || (stateCDD.ts <= (new Date().setHours(0, 0, 0, 0)) && stateCDD.val > 0)) {
                adapter.getState(idnOverallCoveredDistance, function (errOCD, stateOCD) {
                    if (!errOCD && stateOCD) {
                        adapter.setState(idnOverallCoveredDistance, Math.round(stateOCD.val + (stateCDD.val / 1000), 3), true);       // distance in km
                        adapter.log.debug(fctName + '; overall distance: ' + stateOCD.val + ': current covered distance: ' + stateCDD.val / 1000);

                        // move current covered distance to last distance and reset current
                        adapter.log.debug(fctName + '; add current covered distance; lastCoveredDistance: ' + stateCDD.val);
                        adapter.setState(idnLastCoveredDistance, stateCDD.val, true);
                        adapter.setState(idnCurrentCoveredDistance, 0, true);
                        adapter.setState(idnCoveredDistanceDaily, 0, true);
                        mDist = 0;
                        mDistDaily = 0;
                    }
                });
            }
        }
    });

    adapter.log.debug(fctName + '; move lastlocations to lastday locations');
    // move lastlocations to lastday locations
    adapter.getState(idnLastLocations, function (errLC, stateLC) {
        if (!errLC && stateLC) {
            if(bCheck === false || (stateLC.ts <= new Date().setHours(0, 0, 0, 0) && stateLC.val !== '[]')) {
                adapter.setState(idnLastDayLocations, stateLC.val, true);
                adapter.setState(idnLastLocations, '[]', true);
            }
        }
    });

    adapter.log.debug(fctName + '; add daily mowing time to overall mowing time ...');
    // add current mowing time to overall mowing time
    adapter.getState(idnMowingTimeDaily, function (errMTD, stateMTD) {
        if (!errMTD && stateMTD) {
            if(bCheck === false || (stateMTD.ts <= new Date().setHours(0, 0, 0, 0) && stateMTD.val > 0)) {
                adapter.getState(idnOverallMowingTime, function (errOMT, stateOMT) {
                    if (!errOMT && stateOMT) {
                        adapter.setState(idnOverallMowingTime, Math.round(stateOMT.val + (stateMTD.val / 60)), 2);       // in h
                        adapter.log.debug(fctName + '; overall mowing time: ' + stateOMT.val + ': current mowing time: ' + stateMTD.val / 60);

                        // reset daily mowing time
                        adapter.setState(idnMowingTime, 0, true);
                        adapter.setState(idnMowingTimeDaily, 0, true);
                        mMowingTimeDaily = 0;
                        mMowingTime = 0;
                    }
                });
            }
        }
    });

    adapter.log.debug(fctName + '; add daily battery charging cycle to overall charging cycle ...');
    // add daily battery charging cycle to overall charging cycle
    adapter.getState(idnBatteryChargeCycleDaily, function (errCCD, stateCCD) {
        if (!errCCD && stateCCD) {
            if(bCheck === false || (stateCCD.ts <= new Date().setHours(0, 0, 0, 0) && stateCCD.val > 0)) {
                adapter.getState(idnOverallBatteryChargeCycle, function (errOBCC, stateOBCC) {
                    if (!errOBCC && stateOBCC) {
                        adapter.setState(idnOverallBatteryChargeCycle, (stateCCD.val + stateOBCC.val));
                        adapter.log.debug(fctName + '; overall charging cycle: ' + stateCCD.val + ': daily charging cycle: ' + stateOBCC.val);

                        // reset daily charging cycle
                        adapter.setState(idnBatteryChargeCycleDaily, 0, true);
                        mBatteryChargeCycleDaily = 0;
                    }
                });
            }
        }
    });

    // reset daily values
    adapter.setState(idnMowingStartTime, 0, true);

    // start status scheduler, use last timer value
    createStatusScheduler();

    adapter.log.debug(fctName + ' finished');

} // dailyAccumulation()


function updateStatus() {
    const fctName = 'updateStatus';

    adapter.log.debug(fctName + ' started');

    mobjMower.getStatus(function (error, response, result) {
        adapter.log.debug(fctName + ' error: ' + JSON.stringify(error));	// null
//!D!                logs(fctName + ' response: ' + JSON.stringify(response), 'debug2');
        adapter.log.debug(fctName + ' result: ' + JSON.stringify(result));

        let sMsg = '',
        sLastLatitide = '',
        sLastLongitude = '';

        if(result.lastLocations && result.lastLocations.length > 0) {
            sLastLatitide = result.lastLocations[0].latitude;
            sLastLongitude = result.lastLocations[0].longitude;
        }

        result.lastLocations = [];
        // {"batteryPercent":89,"connected":true,"lastErrorCode":0,"lastErrorCodeTimestamp":0,"mowerStatus":"PARKED_AUTOTIMER","nextStartSource":"COMPLETED_CUTTING_TODAY_AUTO","nextStartTimestamp":1524225600,"operatingMode":"AUTO","storedTimestamp":1524158931955,"showAsDisconnected":false,"valueFound":true,"cachedSettingsUUID":"29f71a2b-525d-4c34-9962-0c3aaa0a12d3","lastLocations":null}

        /*
            "batteryPercent": 89,
            "connected": true,
            "lastErrorCode": 0,
            "lastErrorCodeTimestamp": 0,
            "mowerStatus": "PARKED_AUTOTIMER",
            "nextStartSource": "COMPLETED_CUTTING_TODAY_AUTO",
            "nextStartTimestamp": 1524225600,
            "operatingMode": "AUTO",
            "storedTimestamp": 1524158931955,
            "showAsDisconnected": false,
            "valueFound": true,
            "cachedSettingsUUID": "29f71a2b-525d-4c34-9962-0c3aaa0a12d3",
            "lastLocations": null
        */
        adapter.setState(idnLastHttpStatus, response.statusCode, true);
        adapter.setState(idnLastAction, 'status', true);         // aus header oder so --> status|...
        //adapter.setState(idLastActionTime, new Date().getTime());

        if(response.statusCode !== 200) return;

        mLastStatus =  mCurrentStatus;
        mCurrentStatus = result.mowerStatus;

        if(adapter.config.enableJson) {
            adapter.setState(idnRawResponse, JSON.stringify(response), true);
        }

        if(mLastErrorCode !== result.lastErrorCode) {
            adapter.setState(idnCurrentErrorCode, parseInt(result.lastErrorCode), true);
            adapter.setState(idnCurrentErrorCodeTS, (result.lastErrorCodeTimestamp + (mTimeZoneOffset * 60 * 1000)), true);

            if(parseInt(result.lastErrorCode) === 0 && mLastErrorCode > 0) {
                adapter.setState(idnLastErrorCode, mLastErrorCode, true);
                adapter.setState(idnLastErrorCodeTS, mLastErrorCodeTimestamp, true);
            }

            sMsg = 'subscribe mower error state changed, from "' + mLastErrorCode + '" to "' + result.lastErrorCode + '"\r\ncurrent position ' + UrlGoogleMaps + sLastLatitide + ',' + sLastLongitude;
            adapter.setState(idnSendMessage, JSON.stringify([new Date().getTime(), sMsg, 'subscribe mower error state changed', result.lastErrorCode, 2, 'Tg,EL']), true);

            mLastErrorCode = parseInt(result.lastErrorCode);
            mLastErrorCodeTimestamp = result.lastErrorCodeTimestamp + (mTimeZoneOffset * 60 * 1000);
        }

        adapter.setState(idnLastStatus, mCurrentStatus);
        adapter.setState(idnLastStatusTime, parseInt(result.storedTimestamp));

        adapter.setState(idnBatteryPercent, parseInt(result.batteryPercent), true);
        mBatteryPercent = parseInt(result.batteryPercent);
        adapter.setState(idnMowerConnected, result.connected, true);

        adapter.setState(idnNextStartSource, result.nextStartSource, true);
        adapter.setState(idnNextStartTime, parseInt(result.nextStartTimestamp + (mTimeZoneOffset * 60 * 1000)), true);
        adapter.setState(idnOperatingMode, result.operatingMode, true);
//!P! ???
        if(parseInt(result.batteryPercent) === 100 && result.operatingMode === 'HOME') {
            // manuel start required, start mower
            // !P! ?? adapter.setState(idnAMAction, 1, true);

            adapter.log.warn(fctName + ', result.operatingMode === ' + 'HOME', 'mower (should) started');
        }

        //adapter.log.info(' mCurrentStatus: ' + mCurrentStatus + ' mLastStatus: ' + mLastStatus + '; mLastErrorCode: ' + mLastErrorCode + '; mCurrentErrorCode: ' + mCurrentErrorCode + '; mCurrentErrorCodeTimestamp: ' + getDateTimeWseconds(mCurrentErrorCodeTimestamp) + '; mBatteryPercent: ' + mBatteryPercent);
        //mCurrentStatus: PARKED_AUTOTIMER mLastStatus: PARKED_TIMER; mLastErrorCode: 0; mCurrentErrorCode: 0; mCurrentErrorCodeTimestamp: 2018-04-19, 22:12:29; mBatteryPercent: 100
        //adapter.log.info(' mValueFound: ' + mValueFound + '; mStoredTimestamp: ' + getDateTimeWseconds(mStoredTimestamp) + '; mOperatingMode: ' + mOperatingMode + '; mConnected: ' + mConnected + '; mShowAsDisconnected: ' + mShowAsDisconnected);
        //mValueFound: true; mStoredTimestamp: 2018-04-19, 22:00:12; mOperatingMode: AUTO; mConnected: true; mShowAsDisconnected: false

        mobjMower.getGeoStatus(function (geo_error, geo_response, geo_result) {
            adapter.log.debug(fctName + ' geo_error: ' + JSON.stringify(geo_error));	// null
//!D!                logs(fctName + ' geo_response: ' + JSON.stringify(geo_response), 'debug2');
            adapter.log.debug(fctName + ' geo_result: ' + JSON.stringify(geo_result));
            //!D!console.log(fctName + ' geo_result: ' + JSON.stringify(geo_result));

            adapter.setState(idnLastHttpStatus, geo_response.statusCode, true);

            if(geo_response.statusCode !== 200) return;

            if(adapter.config.enableJson) {
                adapter.setState(idnRawResponseGeo, JSON.stringify(geo_result), true);
            }

            let newDist = 0,
                position,
                jsonNewPositions = [],
                bFound = false;

            // assumption: newest data first, confirmed
            // accumulate positions and mileage beginnig from end if array (oldest positions)
            adapter.log.debug(fctName + ', geo_result.lastLocations.length:' + geo_result.lastLocations.length);
            adapter.log.debug(fctName + ', mLastLocationLongi:' + mLastLocationLongi + '; mLastLocationLati:' + mLastLocationLati);
            for (let i = geo_result.lastLocations.length - 1; i >= 0; i--) {
                //adapter.log.debug(fctName + ', i:' + i + '; geo_result.lastLocations[i].longitude:' + geo_result.lastLocations[i].longitude + '; geo_result.lastLocations[i].latitude:' + geo_result.lastLocations[i].latitude);

                // set home location data, if not set
                if(mHomeLocationLongitude === 0 || mHomeLocationLongitude === '' || mHomeLocationLatitude === 0 || mHomeLocationLatitude === '') {
                    mHomeLocationLatitude = geo_result.centralPoint.location.latitude;
                    mHomeLocationLongitude = geo_result.centralPoint.location.longitude;

                    adapter.setState(idnHomeLocationLatitude, mHomeLocationLatitude, true);
                    adapter.setState(idnHomeLocationLongitude, mHomeLocationLongitude, true);
                }
                if(i === geo_result.lastLocations.length - 1) {
                    // write server position data on first loop
                    adapter.setState(idnHomeLocationLatitudeCP, geo_result.centralPoint.location.latitude, true);
                    adapter.setState(idnHomeLocationLongitudeCP, geo_result.centralPoint.location.longitude, true);
                    adapter.setState(idnHomeLocationSensitivityLevel, geo_result.centralPoint.sensitivity.level, true);
                    adapter.setState(idnHomeLocationSensitivityRadius, geo_result.centralPoint.sensitivity.radius, true);
                }

                if(geo_result.lastLocations[i].longitude === mLastLocationLongi && geo_result.lastLocations[i].latitude === mLastLocationLati) {
                    // should like the last known position, data has no timestamp
                    // remove older positions and reset new distance
                    adapter.log.debug(fctName + ' last position found:' + JSON.stringify(geo_result.lastLocations[i]) + '; i:' + i);

                    jsonNewPositions = [];
                    newDist = 0;
                    bFound = true;
                } else {
                    position = { "longitude": geo_result.lastLocations[i].longitude, "latitude": geo_result.lastLocations[i].latitude, "time": result.storedTimestamp};
                    //adapter.log.debug(fctName + ' position:' + JSON.stringify(position) + '; i:' + i + '; mCurrentStatus:' + mCurrentStatus + '; mLastStatus:' + mLastStatus);

                    jsonNewPositions.push(position);      // save position
                    //!P! check location; alle Positionen prüfen oder reicht letze Position --> checkAMatHome
                    // if out of frame --> alarm

                    // add to distance, without timestams it's not poosible to determine cutting position exactly
                    if(i < (geo_result.lastLocations.length - 1) && ((mCurrentStatus === 'OK_CUTTING' || mCurrentStatus === 'OK_CUTTING_NOT_AUTO') || ((mLastStatus === 'OK_CUTTING' || mLastStatus === 'OK_CUTTING_NOT_AUTO') && !(mCurrentStatus === 'OK_CUTTING' || mCurrentStatus === 'OK_CUTTING_NOT_AUTO')))) { // mileage only, if mower cutting
                        if(i === geo_result.lastLocations.length - 1) {
                            newDist = newDist + getDistance(mLastLocationLati, mLastLocationLongi, geo_result.lastLocations[i].latitude, geo_result.lastLocations[i].longitude);
                        } else {
                            newDist = newDist + getDistance(geo_result.lastLocations[i + 1].latitude, geo_result.lastLocations[i + 1].longitude, geo_result.lastLocations[i].latitude, geo_result.lastLocations[i].longitude);
                        }
                        if(bFound) adapter.log.debug(fctName + ', i:' + i + '; newDist:' + newDist + '; [i + 1].latitude:' + geo_result.lastLocations[i + 1].latitude + '; [i + 1].longitude:' + geo_result.lastLocations[i + 1].longitude + '; [i].latitude:' + geo_result.lastLocations[i].latitude + '; [i].longitude:' + geo_result.lastLocations[i].longitude);
                    }
                }
            }
            mJsonLastLocations = mJsonLastLocations.concat(jsonNewPositions);      // add new positions
            mDist = mDist + newDist;
            mDistDaily = mDistDaily + newDist;
            adapter.log.debug(fctName + ', add new distance; mDist: ' + mDist + '; mDistDaily: ' + mDistDaily + '; newDist: ' + newDist);

            // check position in range
            checkAMatHome(geo_result.lastLocations[0].latitude, geo_result.lastLocations[0].longitude);

            //adapter.log.debug(fctName + '; idnLastLocations: ' + JSON.stringify(mJsonLastLocations));
            adapter.log.debug(fctName + '; idnCurrentCoveredDistance: ' + Math.round(mDist, 2));
            adapter.log.debug(fctName + '; idnCoveredDistanceDaily: ' + Math.round(mDistDaily, 2));
            adapter.setState(idnLastLocations, JSON.stringify(mJsonLastLocations), true);
            adapter.setState(idnCurrentCoveredDistance, Math.round(mDist, 2), true);

            if(mLastLocationLongi !== geo_result.lastLocations[0].longitude && mLastLocationLongi !== geo_result.lastLocations[0].latitude) {
                // update last location
                adapter.setState(idnLastLocationLongitude, geo_result.lastLocations[0].longitude, true);
                adapter.setState(idnLastLocationLatitude, geo_result.lastLocations[0].latitude, true);

                mLastLocationLongi = geo_result.lastLocations[0].longitude;
                mLastLocationLati = geo_result.lastLocations[0].latitude;

                adapter.setState(idnLastLocationTimestamp, result.storedTimestamp, true);      // !?

                // Offset
                if(mCurrentStatus === 'OK_CHARGING' || mCurrentStatus === 'PARKED_AUTOTIMER' || mCurrentStatus === 'PARKED_PARKED_SELECTED' || mCurrentStatus === 'PARKED_TIMER' || mCurrentStatus === 'OFF_DISABLED') {
                    adapter.setState(idnHomeLocationLongitudeOffset, geo_result.lastLocations[0].longitude, true);
                    adapter.setState(idnHomeLocationLatitudeOffset, geo_result.lastLocations[0].latitude, true);
                }
            }
            adapter.log.debug(fctName + ' geo finished');
        }); // mobjMower.getGeoStatus

        adapter.log.debug(fctName + ', mCurrentStatus: ' + mCurrentStatus + '; mCurrentStatus === \'OK_CUTTING\': ' + (mCurrentStatus === 'OK_CUTTING') + '; mLastStatus: ' + mLastStatus + '; mStartMowingTime: ' + mStartMowingTime + '; mMowingTime: ' + mMowingTime);

        // !P! wenn Status sich ändert haben wir tc oder? - Wofür?
        if(mCurrentStatus != mLastStatus) {
            sMsg = 'updateStatus, mower state changed, from "' + mLastStatus + '" to "' + mCurrentStatus + '"';
            adapter.setState(idnSendMessage, JSON.stringify([new Date().getTime(), sMsg, 'mower state changed', mCurrentStatus, 1, 'Tg,EL']), true);

            adapter.setState(idnLastStatusChangeTime, result.storedTimestamp, true);
        }

        if(mCurrentStatus === 'OK_CUTTING' || mCurrentStatus === 'OK_CUTTING_NOT_AUTO') {
            // reset start timer after rain, mower is started manually?
            if (mWaitAfterRainTimer !== null) {
                //!P! clearTimeout(mWaitAfterRainTimer);
                mWaitAfterRainTimer.cancel;

                adapter.setState(idnTimerAfterRainStartAt, 0, true);
            }

            // reset autostart timer, mower is started
            if (mWaitAutoTimer !== null) {
                //!P! clearTimeout(mWaitAutoTimer);
                mWaitAutoTimer.cancel;

                mWaitAutoTimer = null;
                adapter.setState(idnNextStartWatching, false, true);
            }

            if(mStartMowingTime === 0) {
                // start mowing
                mStartMowingTime = new Date().getTime();
                adapter.setState(idnMowingStartTime, mStartMowingTime, true);
            }
            if(((mLastStatus === 'OK_CUTTING' || mLastStatus === 'OK_CUTTING_NOT_AUTO') || mLastStatus === 'unknown') && mStartMowingTime > 0) {  //  === 0 --> processed in other action like OK_SEARCHING or adapter restarted
                // mowing
                let newMowingTIme = ((new Date().getTime() - mStartMowingTime) / (1000 * 60));

                mMowingTime += newMowingTIme;
                mMowingTimeDaily += newMowingTIme;
                mStartMowingTime = new Date().getTime();

                adapter.setState(idnMowingTime, Math.round(mMowingTime), true);
                adapter.setState(idnMowingTimeDaily, Math.round(mMowingTimeDaily), true);

                adapter.log.debug(fctName + ', mower in action; mLastStatus: ' + mLastStatus + '; mStartMowingTime: ' + mStartMowingTime + '; mMowingTime: ' + mMowingTime + '; mMowingTimeDaily: ' + mMowingTimeDaily + '; newMowingTIme: ' + newMowingTIme);
            }
        }

        if((mCurrentStatus !== 'OK_CUTTING' && mCurrentStatus !== 'OK_CUTTING_NOT_AUTO') && (mLastStatus === 'OK_CUTTING' || mLastStatus === 'OK_CUTTING_NOT_AUTO') && mStartMowingTime > 0) {
            // mowing finished/break/error --> add last mowing time
            // timediff in ms --> min
            let newMowingTIme = ((new Date().getTime() - mStartMowingTime) / (1000 * 60));

            mMowingTime += newMowingTIme;
            mMowingTimeDaily += newMowingTIme;

            adapter.setState(idnMowingTime, Math.round(mMowingTime), true);
            adapter.setState(idnMowingTimeDaily, Math.round(mMowingTimeDaily), true);

            adapter.log.debug(fctName + ', mowing finished/break; mLastStatus: ' + mLastStatus + '; mStartMowingTime: ' + mStartMowingTime + '; mMowingTime: ' + mMowingTime + '; mMowingTimeDaily: ' + mMowingTimeDaily);
            mStartMowingTime = 0;
            mMowingTime = 0;
            mDist = 0;
        }

        if(mCurrentStatus === 'OK_LEAVING' && mLastStatus !== 'OK_LEAVING' && mStartMowingTime === 0) {
            mStartMowingTime = new Date().getTime();        // start mowing

            adapter.setState(idnMowingStartTime, mStartMowingTime, true);
        }

        if(mCurrentStatus === 'OK_SEARCHING' && mLastStatus !== 'OK_SEARCHING' && mSearchingStartTime === 0) {
            // start searching
            mSearchingStartTime = new Date().getTime();
            adapter.setState(idnLastDockingTime, mSearchingStartTime, true);
            adapter.log.debug(fctName + ', start searching; mSearchingStartTime: ' + mSearchingStartTime);

            // regular mowing finished, update last mowing time
            if(mMowingTimeBatteryNew > 0) {
                mLastMowingTime = mMowingTime;
                adapter.setState(idnLastMowingTime, Math.round(mLastMowingTime), true);
            } else {
                // set first mowing time
                mMowingTimeBatteryNew = mMowingTime;
                adapter.setState(idnMowingTimeBatteryNew, Math.round(mMowingTimeBatteryNew), true);
            }
        }

        // time too find station
        if((mCurrentStatus === 'OK_CHARGING' || mCurrentStatus === 'XXXXXX' || mCurrentStatus === 'XXXXXXX') && mSearchingStartTime > 0) {
            let searchTime = parseInt((new Date().getTime() - mSearchingStartTime) / (1000 * 60));
            adapter.setState(idnLastStationReturnTime, searchTime, true);
            adapter.log.debug(fctName + ', search finshed; mSearchingStartTime: ' + mSearchingStartTime + '; searchTime: ' + searchTime);

            mSearchingStartTime = 0;
        }

        if(mCurrentStatus === 'OK_CHARGING' && mLastStatus !== 'OK_CHARGING') {     // mLastStatus === 'unknown' or other regular status
            if(mChargingStartTime === 0 || mChargingStartTime < (new Date().getTime() - mChargingTimeBatteryNew)) { //
                // start charging
                mChargingStartTime = new Date().getTime();
                adapter.setState(idnChargingStartTime, mChargingStartTime, true);

                ++mBatteryChargeCycleDaily;
                adapter.setState(idnBatteryChargeCycleDaily, mBatteryChargeCycleDaily, true);
            }

            // mLastMowingTime / mMowingTimeBatteryNew --> efficiency factor
            if(mLastMowingTime > 0 && mMowingTimeBatteryNew > 0) adapter.setState(idnBatteryEfficiencyFactor, Math.round(mLastMowingTime / mMowingTimeBatteryNew * 100, 2), true);

            adapter.log.debug(fctName + ', mower start charging; mChargingStartTime: ' + mChargingStartTime + '; mBatteryChargeCycleDaily: ' + mBatteryChargeCycleDaily + '; mLastMowingTime: ' + mLastMowingTime + '; mMowingTimeBatteryNew: ' + mMowingTimeBatteryNew);
        }
        if(mCurrentStatus === 'OK_CHARGING' && mLastStatus === 'OK_CHARGING') {
            // charging
            if(mChargingStartTime > 0) {
                let newChargingTime = parseInt((new Date().getTime() - mChargingStartTime) / (1000 * 60));

                adapter.log.debug(fctName + ', mower charging; newChargingTime: ' + newChargingTime + '; mChargingTimeBatteryCurrent: ' + mChargingTimeBatteryCurrent + '; mChargingTimeBatteryDaily: ' + mChargingTimeBatteryDaily);

                mChargingTimeBatteryCurrent += newChargingTime;
                mChargingTimeBatteryDaily += newChargingTime;
                adapter.setState(idnChargingTimeBatteryCurrent, mChargingTimeBatteryCurrent, true);
                adapter.setState(idnChargingTimeBatteryDaily, mChargingTimeBatteryDaily, true);
            }
            mChargingStartTime = new Date().getTime();
        }
        if(mCurrentStatus !== 'OK_CHARGING' && mLastStatus === 'OK_CHARGING' && mChargingStartTime > 0) {
            // charging end
            adapter.log.debug(fctName + ', mower charging end; mChargingStartTime: ' + mChargingStartTime + '; new Date().getTime(): ' + new Date().getTime() + '; mLastMowingTime: ' + mLastMowingTime + '; mMowingTimeBatteryNew: ' + mMowingTimeBatteryNew);
//mChargingStartTime: 1526479183267; new Date().getTime(): 1526479484644; mLastMowingTime: 0; mMowingTimeBatteryNew: 703

            let newChargingTime = parseInt((new Date().getTime() - mChargingStartTime) / (1000 * 60));

            mChargingTimeBatteryCurrent += newChargingTime;
            mChargingTimeBatteryDaily += newChargingTime;
            adapter.setState(idnChargingTimeBatteryCurrent, mChargingTimeBatteryCurrent, true);
            adapter.setState(idnChargingTimeBatteryDaily, mChargingTimeBatteryDaily, true);
            adapter.log.debug(fctName + ', mower charging end; mChargingTimeBatteryCurrent: ' + mChargingTimeBatteryCurrent + '; mChargingTimeBatteryDaily: ' + mChargingTimeBatteryDaily + '; newChargingTime: ' + newChargingTime);

            if(mChargingTimeBatteryNew === 0) {
                adapter.setState(idnChargingTimeBatteryNew, mChargingTimeBatteryCurrent, true);
            }
            mChargingStartTime = 0;
            mChargingTimeBatteryCurrent = 0;
            // !P! ??? adapter.setState(idnChargingStartTime, mChargingStartTime, true);
        }

        adapter.log.debug(fctName + ', mBatteryPercent: ' + mBatteryPercent + '; mScheduleStatus: ' + mScheduleStatus + '; mScheduleTime: ' + mScheduleTime + '; adapter.config.pollInactive: ' + adapter.config.pollInactive);
        if(mCurrentStatus === 'OK_CHARGING' && mBatteryPercent <= 95) {
            // laden
            if(mScheduleStatus === null || (mScheduleStatus !== null && mScheduleTime !== adapter.config.pollInactive)) {
                mScheduleTime = adapter.config.pollInactive;

                createStatusScheduler();
            }
        } else {
            // error or active or BatteryPercent > 95%
            if(mScheduleStatus === null || (mScheduleStatus !== null && mScheduleTime !== adapter.config.pollActive)) {
                mScheduleTime = adapter.config.pollActive;

                createStatusScheduler();
            }
        }

        /*
            PARKED_AUTOTIMER
            PARKED_PARKED_SELECTED
            PARKED_TIMER

                                            if(mCurrentStatus === 'PARKED_AUTOTIMER' && mWaitAutoTimer === null) {
                                                // should be started on nextStarttimer --> watch
                                                let nextStart = adapter.getState(idNextStartTimestamp).val;
                                                nextStart = dateAdd(nextStart, - mTimeZoneOffset, 'hours');          // get local time
                                                let nextStart2 = nextStart - (1000 * 60 * mTimeZoneOffset) ;
                                                logs(fctName + '; mCurrentStatus === "PARKED_AUTOTIMER", mWaitAutoTimer' + nextStart + '; nextStart2: ' + nextStart2 + '; current time:' + new Date().getTime(), 'debug2');

                                                if(nextStart - new Date().getTime() > 0) {
                                                    mWaitAutoTimer = setTimeout(startMowerAfterAutoTimerCheck, nextStart - new Date().getTime() + 60000);       //plant start + 60s

                                                    setState(idNextStartWatching, true);

                                                    sMsg = 'mower state changed, next autostart on "' + formatDate(nextStart, "JJJJ.MM.TT SS:mm:ss") + '"';
                                                    adapter.setState(idnSendMessage, JSON.stringify([new Date().getTime(), sMsg, 'subscribe mower error state changed', nextStart - new Date().getTime() + 60000, 1, 'Tg,EL']), true);
                                                }
                                            }
        */
        if(mCurrentStatus === 'PARKED_AUTOTIMER' || mCurrentStatus === 'PARKED_PARKED_SELECTED' || mCurrentStatus === 'PARKED_TIMER') {
            let nTime = (mNextStart - new Date().getTime()) / 1000;     // seconds to start mower
            adapter.log.debug(fctName + '; mCurrentStatus === "' + mCurrentStatus + '", seconds to next start' + nTime);

            if(mStoppedDueRain === true && (nTime < parseInt(adapter.config.pollInactive))) {
                adapter.log.debug(fctName + '; stop autostart while rain');

                mobjMower.sendCommand(mobjMower.command.stop, (err, msg) => {
                    if (err) {
                        adapter.log(msg);
                    } else {
                        adapter.log("Parked the mower");
                    }
                });

                sMsg = 'mower stop send while rain state is true';
                adapter.setState(idnSendMessage, JSON.stringify([new Date().getTime(), sMsg, 'mower stop send', '', 1, 'Tg,EL']), true);
            }
        }
    });

    adapter.log.debug(fctName + ' finhed');

} // updateStatus()


// is called when databases are connected and adapter received configuration.
// start here!
adapter.on('ready', function () {
    main();
});


function syncConfig(callback) {
    const fctName = 'syncConfig';

    adapter.log.debug(fctName + ' started');

    adapter.getState(idnLastLocations, function (err, idState) {
        if (err) {
            adapter.log.error(err);

            callback();
        }

        // on getStates serveral problems on reading, string too long?
        mJsonLastLocations = JSON.parse(idState.val);

        adapter.log.debug(fctName + ', mJsonLastLocations:' + mJsonLastLocations);
    });

    adapter.getStates('mower.*', function (err, idStates) {
        if (err) {
            adapter.log.error(err);

            callback();
        }

        // gather states that need to be read
        adapter.log.debug(fctName + ' idStates: ' + JSON.stringify(idStates));

        for (let idState in idStates) {
            if (!idStates.hasOwnProperty(idState) || idStates[idState] === null) {
                //if (!idStates.hasOwnProperty(idState)) {
                continue;
            }

            let iddp = idState.substr(adapter.namespace.length + 1);
            adapter.log.debug(fctName + ', processing state:' + iddp);

            switch (iddp) {
                case idnLastStatus:
                    mLastStatus = idStates[idState].val;
                    break;
                case idnLastStatusChangeTime:
                    mLastStatusChangeTime = idStates[idState].val;
                    break;
                case idnNextStartTime:
                    mNextStart = idStates[idState].val;
                    break;
                case idnStoppedDueRain:
                    mStoppedDueRain = idStates[idState].val;
                    break;
                case idnCurrentErrorCode:
                    mLastErrorCode = idStates[idState].val;
                    break;
                case idnCurrentErrorCodeTS:
                    mLastErrorCodeTimestamp = idStates[idState].val;
                    break;
                case idnCurrentCoveredDistance:
                    mDist = JSON.parse(idStates[idState].val);
                    break;
                case idnCoveredDistanceDaily:
                    mDistDaily = JSON.parse(idStates[idState].val);
                    break;
                case idnLastLocationLongitude:
                    mLastLocationLongi = JSON.parse(idStates[idState].val);
                    break;
                case idnLastLocationLatitude:
                    mLastLocationLati = JSON.parse(idStates[idState].val);
                    break;
                case idnHomeLocationLongitude:
                    mHomeLocationLongitude = idStates[idState].val;
                    break;
                case idnHomeLocationLatitude:
                    mHomeLocationLatitude = idStates[idState].val;
                    break;
                case idnBatteryPercent:
                    mBatteryPercent = parseInt(idStates[idState].val);
                    break;
                case idnBatteryChargeCycleDaily:
                    mBatteryChargeCycleDaily = parseInt(idStates[idState].val);
                    break;
                case idnMowingStartTime:
                    mStartMowingTime = parseInt(idStates[idState].val);
                    break;
                case idnLastMowingTime:
                    mLastMowingTime = parseInt(idStates[idState].val);
                    break;
                case idnMowingTimeBatteryNew:
                    mMowingTimeBatteryNew = parseInt(idStates[idState].val);
                    break;
                case idnChargingStartTime:
                    mChargingStartTime = parseInt(idStates[idState].val);
                    break;
                case idnChargingTimeBatteryNew:
                    mChargingTimeBatteryNew = parseInt(idStates[idState].val);
                    break;
                case idnChargingTimeBatteryCurrent:
                    mChargingTimeBatteryCurrent = parseInt(idStates[idState].val);
                    break;
                case idnChargingTimeBatteryDaily:
                    mChargingTimeBatteryDaily = parseInt(idStates[idState].val);
                    break;
                case idnMowingTime:
                    mMowingTime = parseInt(idStates[idState].val);
                    break;
                case idnMowingTimeDaily:
                    mMowingTimeDaily = parseInt(idStates[idState].val);
                    break;
            }
        }
        adapter.log.debug(fctName + ', idnLastStatus: ' + mLastStatus + ', idnNextStartTime: ' + mNextStart + ', idnStoppedDueRain: ' + mStoppedDueRain + ', idnCurrentErrorCode: ' + mLastErrorCode + ', idnCurrentErrorCodeTS: ' + mLastErrorCodeTimestamp);
        adapter.log.debug(fctName + ', idnCurrentCoveredDistance: ' + mDist + ', idnLastLocationLongitude: ' + mLastLocationLongi + ', idnLastLocationLatitude: ' + mLastLocationLati + ', idnHomeLocationLongitude: ' + mHomeLocationLongitude + ', idnHomeLocationLatitude: ' + mHomeLocationLongitude);
        adapter.log.debug(fctName + ', idnBatteryPercent: ' + mBatteryPercent + ', idnBatteryChargeCycleDaily: ' + mBatteryChargeCycleDaily + ', idnMowingTime: ' + mMowingTime + ', idnMowingTimeDaily: ' + mMowingTimeDaily);
        //adapter.log.debug(fctName + ', idnLastLocations: ' + JSON.stringify(mJsonLastLocations));
    });

    adapter.log.debug(fctName + ' finished');

    callback && callback();

} // syncConfig()


// After API login
husqApi.on('login', () => {
    adapter.log.info("Logged on. Checking for mowers.");
    // Get a list of mowers belonging to this account
    husqApi.getMowers();
});


// After API logout
husqApi.on('logout', () => {
    adapter.log.info("Logged off.");
});


// When we get our intial list of mowers
// mowers = array of HMower objects
husqApi.on('mowersListUpdated', (mowers) => {
    adapter.log.info("Found " + mowers.length + " mower(s)");

    // configurierten Index --> adapter.config.index
    // !P! > mowerIndex && mowers[i].X.name === nickname
    if (mowers.length > 0) {
        //adapter.log.info("mobjMower: " + JSON.stringify(mobjMower));
        adapter.setState(idnMowersJson, JSON.stringify(mowers), true);

        if(mowers.length > 1) {
            let ix = 0;
            mowers.forEach(function (mower) {
                if (mower.mower.name === adapter.config.nickname) {
                    mobjMower = mower;
                    //adapter.log.debug('updateStatus' + ' mobjMower: ' + JSON.stringify(mobjMower));

                    adapter.setState(idnMowerID, mobjMower.mower.id, true);
                    adapter.setState(idnMowerModel, mobjMower.mower.model, true);
                    adapter.setState(idnMowersIndex, ix, true);

                    updateStatus();

                    return true;
                }
                ix++;
            });
        } else {
            mobjMower = mowers[0];
            //adapter.log.debug('updateStatus' + ' mobjMower: ' + JSON.stringify(mobjMower));

            adapter.setState(idnMowerNickname, mobjMower.mower.name, true);
            adapter.setState(idnMowerID, mobjMower.mower.id, true);
            adapter.setState(idnMowerModel, mobjMower.mower.model, true);
            adapter.setState(idnMowersIndex, 0, true);

            updateStatus();
        }
    }
}); // husqApi.on()


function createSubscriber() {

    if (adapter.setState) adapter.setState('info.connection', true, true);

    if(adapter.config.idRainSensor !== '') {        // use only rain sensor
        adapter.getForeignState(adapter.config.idRainSensor, function (err, idState) {
            if (err) {
                adapter.log.error(err);

                return;
            }

            // id rain sensor valid
            adapter.subscribeForeignStates(adapter.config.idRainSensor);
        });
    } else if (adapter.config.idWeatherRainForecast !== '') { // alternate use forecast
        adapter.getForeignState(adapter.config.idWeatherRainForecast, function (err, idState) {
            if (err) {
                adapter.log.error(err);

                return;
            }

            adapter.subscribeForeignStates(adapter.config.idWeatherRainForecast);
        });
    }

    // daily accumulation
    //!P!scheduleDailyAccumulation = schedule("0 0 * * *", function () {
    mScheduleDailyAccumulation = husqSchedule.scheduleJob({hour: 0, minute: 0}, function () {
        dailyAccumulation();
    });

} // createSubscriber()


function mower_login() {
    husqApi.logout();
    husqApi.login(adapter.config.email, adapter.config.pwd);
} // mower_login()


function main() {

    if (adapter.config.pwd === "PASSWORT") {

        adapter.log.error("Bitte die Felder E-Mail und Passwort ausfüllen!");
        adapter.setState('info.connected', false, true);
    }
    else {
        createDataStructure();

        adapter.log.debug('Mail address: ' + adapter.config.email);
        //adapter.log.debug('Password were set to: ' + adapter.config.pwd);

        mQueryIntervalActive_s = adapter.config.pollActive;
        if (isNaN(mQueryIntervalActive_s) || mQueryIntervalActive_s < 31) {
            mQueryIntervalActive_s = 60;
        }

        mQueryIntervalInactive_s = adapter.config.pollInactive;
        if (isNaN(mQueryIntervalInactive_s) || mQueryIntervalInactive_s < 300) {
            mQueryIntervalInactive_s = 300;
        }
        mMaxDistance = adapter.config.homeLocation_maxDistance;
        if (isNaN(mMaxDistance) || mMaxDistance < 10) {
            mMaxDistance = 10;
        }
        mWaitAfterRain_m = adapter.config.waitAfterRain_m;
        if (isNaN(mWaitAfterRain_m) || mWaitAfterRain_m < 60) {
            mWaitAfterRain_m = 60;
        }

        syncConfig(function (){
            dailyAccumulation(true);        // test, if untouched values from yesterday

            mower_login();

            createSubscriber();
        });
        //setTimeout(syncConfig, 500);

        // subscribe own events
        adapter.subscribeStates('*');

        //setTimeout(mower_login, 1000);

        //setTimeout(createSubscriber, 2000);
        adapter.setState(idnHomeLocationMaxDistance, mMaxDistance, true);
    }
} // main()

// cfg:
// email
// passwort
// Mäher-Index, disabled
// Nickname, identify mower
// Abfrage-Intervall aktiv
// Abfrage-Intervall inaktiv
// mower.homeLocation.latitude      // geladen von Husqvarana central point
// mower.homeLocation.longitude     // geladen von Husqvarana central point
// mower.homeLocation.maxDistance
// mower.homeLocation.name
// Rohdaten hinzufügen ???
// erweiterte Statistik
// id für TimeZoneOffset
// idRainSensor
// RainSensorValue - [bool, true]
// stopOnRainEnabled
// idWeatherRainForecast
// stopOnRainPercent

// mqtt.0.hm-rpc.0.OEQ0996420.1.STATE
// weatherunderground.1.forecast.0h.qpf


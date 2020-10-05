/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var { ExtensionCommon } = ChromeUtils.import("resource://gre/modules/ExtensionCommon.jsm");
var { ExtensionUtils } = ChromeUtils.import("resource://gre/modules/ExtensionUtils.jsm");

var { ExtensionAPI, EventManager } = ExtensionCommon;
var { parseMatchPatterns, ExtensionError } = ExtensionUtils;

var { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
var { cal } = ChromeUtils.import("resource:///modules/calendar/calUtils.jsm");

this.calendar_calendars = class extends ExtensionAPI {
  getAPI(context) {
    const calmgr = cal.getCalendarManager();
    const {
      getResolvedCalendarById,
      isOwnCalendar,
      convertCalendar,
    } = ChromeUtils.import("resource://ext-calendar-draft/api/ext-calendar-utils.jsm");

    return {
      calendar: {
        calendars: {
          query: async function({ type, url, name, color, readOnly, enabled }) {
            let calendars = calmgr.getCalendars();

            let patterns = url ? parseMatchPatterns([url]) : null;

            return calendars
              .filter(calendar => {
                let matches = true;

                if (type && calendar.type != type) {
                  matches = false;
                }

                if (url && !patterns.matches(calendar.uri)) {
                  matches = false;
                }

                if (name && !new MatchGlob(name).matches(calendar.name)) {
                  matches = false;
                }

                if (color && color != calendar.getProperty("color")) {
                  // TODO need to normalize the color, including null to default color
                  matches = false;
                }

                if (enabled != null && calendar.getProperty("disabled") == enabled) {
                  matches = false;
                }

                if (readOnly != null && calendar.readOnly != readOnly) {
                  matches = false;
                }

                return matches;
              })
              .map(calendar => convertCalendar(context.extension, calendar));
          },
          get: async function(id) {
            // TODO find a better way to determine cache id
            if (id.endsWith("#cache")) {
              let calendar = calmgr.getCalendarById(id.substring(0, id.length - 6));
              let own = calendar.offlineStorage && isOwnCalendar(context.extension, calendar);
              return own ? convertCalendar(context.extension, calendar.offlineStorage) : null;
            } else {
              let calendar = calmgr.getCalendarById(id);
              return convertCalendar(context.extension, calendar);
            }
          },
          create: async function(createProperties) {
            let calendar = calmgr.createCalendar(
              createProperties.type,
              Services.io.newURI(createProperties.url)
            );
            if (!calendar) {
              throw new ExtensionError(`Calendar type ${createProperties.type} is unknown`);
            }

            calendar.name = createProperties.name;
            if (typeof createProperties.color != "undefined") {
              calendar.setProperty("color", createProperties.color);
            }

            calmgr.registerCalendar(calendar);

            calendar = calmgr.getCalendarById(calendar.id);
            return convertCalendar(context.extension, calendar);
          },
          update: async function(id, updateProperties) {
            let calendar = calmgr.getCalendarById(id);
            if (!calendar) {
              throw new ExtensionError(`Invalid calendar id: ${id}`);
            }

            if (updateProperties.capabilities && !isOwnCalendar(context.extension, calendar)) {
              throw new ExtensionError("Cannot update capabilities for foreign calendars");
            }
            if (updateProperties.url && !isOwnCalendar(context.extension, calendar)) {
              throw new ExtensionError("Cannot update url for foreign calendars");
            }

            if (updateProperties.url) {
              calendar.uri = Services.io.newURI(updateProperties.url);
            }

            if (updateProperties.enabled != null) {
              calendar.setProperty("disabled", !updateProperties.enabled);
            }

            for (let prop of ["readOnly", "name", "color"]) {
              if (updateProperties[prop] != null) {
                calendar.setProperty(prop, updateProperties[prop]);
              }
            }

            // TODO capabilities merging
          },
          remove: async function(id) {
            let calendar = calmgr.getCalendarById(id);
            if (!calendar) {
              throw new ExtensionError(`Invalid calendar id: ${id}`);
            }

            calmgr.unregisterCalendar(calendar);
          },
          clear: async function(id) {
            if (!id.endsWith("#cache")) {
              throw new ExtensionError("Cannot clear non-cached calendar");
            }

            let offlineStorage = getResolvedCalendarById(context.extension, id);
            let calendar = calmgr.getCalendarById(id.substring(0, id.length - 6));

            if (!isOwnCalendar(context.extension, calendar)) {
              throw new ExtensionError("Cannot clear foreign calendar");
            }

            await new Promise((resolve, reject) => {
              let listener = {
                onDeleteCalendar(aCalendar, aStatus, aDetail) {
                  if (Components.isSuccessCode(aStatus)) {
                    resolve();
                  } else {
                    reject(aDetail);
                  }
                },
              };
              offlineStorage
                .QueryInterface(Ci.calICalendarProvider)
                .deleteCalendar(offlineStorage, listener);
            });

            calendar.wrappedJSObject.mObservers.notify("onLoad", [calendar]);
          },

          onCreated: new EventManager({
            context,
            name: "calendar.calendars.onCreated",
            register: fire => {
              let observer = {
                QueryInterface: ChromeUtils.generateQI(["calICalendarManagerObserver"]),
                onCalendarRegistered(calendar) {
                  fire.sync(convertCalendar(context.extension, calendar));
                },
                onCalendarUnregistering(calendar) {},
                onCalendarDeleting(calendar) {},
              };

              cal.getCalendarManager().addObserver(observer);
              return () => {
                cal.getCalendarManager().removeObserver(observer);
              };
            },
          }).api(),

          onUpdated: new EventManager({
            context,
            name: "calendar.calendars.onUpdated",
            register: fire => {
              let observer = cal.createAdapter(Ci.calIObserver, {
                onPropertyChanged(calendar, name, value, oldValue) {
                  let converted = convertCalendar(context.extension, calendar);
                  switch (name) {
                    case "name":
                    case "color":
                    case "readOnly":
                      fire.sync(converted, { [name]: value });
                      break;
                    case "uri":
                      fire.sync(converted, { url: value?.spec });
                      break;
                    case "disabled":
                      fire.sync(converted, { enabled: !value });
                      break;
                  }
                },
              });

              cal.getCalendarManager().addCalendarObserver(observer);
              return () => {
                cal.getCalendarManager().removeCalendarObserver(observer);
              };
            },
          }).api(),

          onRemoved: new EventManager({
            context,
            name: "calendar.calendars.onRemoved",
            register: fire => {
              let observer = {
                QueryInterface: ChromeUtils.generateQI(["calICalendarManagerObserver"]),
                onCalendarRegistered(calendar) {},
                onCalendarUnregistering(calendar) {
                  fire.sync(calendar.id);
                },
                onCalendarDeleting(calendar) {},
              };

              cal.getCalendarManager().addObserver(observer);
              return () => {
                cal.getCalendarManager().removeObserver(observer);
              };
            },
          }).api(),
        },
      },
    };
  }
};
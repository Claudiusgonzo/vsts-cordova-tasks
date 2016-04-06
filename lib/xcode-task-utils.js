/*
  Copyright (c) Microsoft. All rights reserved.  
  Licensed under the MIT license. See LICENSE file in the project root for full license information.
*/

var path = require("path"),
    fs = require("fs"),
    Q = require("q"),
    shelljs = require("shelljs"),
    exec = Q.nfbind(require("child_process").exec),
    spawn = Q.nfbind(require("child_process").spawn);

function determineIdentity(input) {
    console.log("Input to determineIdentity: " + JSON.stringify(input));
    // Unlock keychain?
    var promise;
    if (input.unlockDefaultKeychain) {
        var unlockKeychain = shelljs.which("bash", true);
        var unlockKeychainArgs = [path.resolve(__dirname, "unlockdefaultkeychain.sh"), input.defaultKeychainPassword];
        promise = spawn(unlockKeychain, unlockKeychainArgs, { stdio: "inherit" });
    } else {
        promise = Q({});
    }

    // Add identity arg if specified
    // If p12 specified, create temporary keychain, import it, add to search path
    var p12 = input.p12;
    if (p12 && fs.lstatSync(p12).isFile()) {
        p12 = path.resolve(input.cwd, p12);
        var keychain = path.join(input.cwd, "_tasktmp.keychain");
        var keychainPwd = Math.random();

        var createKeychain = shelljs.which("bash", true);
        var createKeychainArgs = [path.resolve(__dirname, "createkeychain.sh"), keychain, keychainPwd, p12, input.p12pwd];

        // Configure keychain delete command
        var deleteCommand = "/usr/bin/security";
        var deleteCommandArgs = ["delete-keychain", keychain];

        promise = promise.then(function(code) {
            return spawn(createKeychain, createKeychainArgs, { stdio: "inherit" });
        });

        // Run command to set the identity based on the contents of the p12 if not specified in task config
        return promise.then(function() {
            return exec('/usr/bin/security find-identity -v -p codesigning "' + keychain + '" | grep -oE \'"(.+?)"\'');
        })
            .then(function(foundIdent) {
                foundIdent = removeExecOutputNoise(foundIdent)
                var ident;
                if (input.iosSigningIdentity) {
                    console.warn("Signing Identitiy specified along with P12 Certificate. Omit Signing Identity in task to ensure p12 value used.");
                    ident = input.iosSigningIdentity;
                } else {
                    ident = foundIdent;
                }
                return ({
                    identity: ident,
                    foundIdentity: foundIdent,
                    keychain: keychain,
                    deleteCommand: function() {
                        return spawn(deleteCommand, deleteCommandArgs, { stdio: "inherit" });
                    }
                });
            });
    } else {
        console.log("p12 not specified in task.");
        return promise.then(function() {
            return { identity: input.iosSigningIdentity };
        });
    }
}

function determineProfile(input) {
    console.log('Input to determineProfile: ' + JSON.stringify(input));
    if (input.provProfilePath) {
        var profilePath = path.resolve(input.cwd, input.provProfilePath);
        if (fs.existsSync(profilePath) && fs.lstatSync(profilePath).isFile()) {
            console.log('Provisioning profile file found.')
            // Get UUID of provisioning profile
            return exec('/usr/libexec/PlistBuddy -c "Print UUID" /dev/stdin <<< $(/usr/bin/security cms -D -i "' + profilePath + '")')
                .then(function(foundUuid) {
                    foundUuid = removeExecOutputNoise(foundUuid);
                    console.log(profilePath + ' has UUID of ' + foundUuid);

                    // Esnure user's profile path exsits, set new filename using UUID
                    var userProfilesPath = path.join(process.env['HOME'], 'Library', 'MobileDevice', 'Provisioning Profiles');
                    shelljs.mkdir("-p", userProfilesPath);
                    var newProfilePath = path.join(userProfilesPath, foundUuid + '.mobileprovision');

                    // Create delete profile call if flag specified
                    var deleteCommand;
                    if (input.removeProfile) {
                        deleteCommand = function() {
                            shelljs.rm("-f", newProfilePath);
                            return Q(0);
                        };
                    }

                    // copy
                    shelljs.cp("-f", profilePath, newProfilerPath);

                    var uuid;
                    if (input.provProfileUuid) {
                        console.warn('Profile UUID specified along with Profile Path. Omit Profile UUID in task to ensure the file\'s UUID value used.');
                        uuid = input.provProfileUuid;
                    } else {
                        uuid = foundUuid;
                    }

                    return Q({
                        uuid: uuid,
                        foundUuid: foundUuid,
                        deleteCommand: deleteCommand
                    });
                });
        }
    }
    return Q({ uuid: input.provProfileUuid });
}

function removeExecOutputNoise(input) {
    var output = input + "";
    output = output.trim().replace(/[",\n\r\f\v]/gm, '');
    return output;
}

module.exports = {
    determineIdentity: determineIdentity,
    determineProfile: determineProfile
}
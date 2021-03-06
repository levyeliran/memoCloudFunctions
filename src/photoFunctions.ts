/**
 * https://github.com/GoogleCloudPlatform/google-cloud-node/issues/952
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for t`he specific language governing permissions and
 * limitations under the License.
 */
import {extractData} from "./extractDataHelper";
import {FBData} from "./utilities/FBData";

const functions = require('firebase-functions');
const mkdirp = require('mkdirp-promise');
// Include a Service Account Key to use a Signed URL
const gcs = require('@google-cloud/storage')({keyFilename: 'Memo-service-accounts.json'});
const admin = require('firebase-admin');
const spawn = require('child-process-promise').spawn;
const path = require('path');
const os = require('os');
const fs = require('fs');

// Max height and width of the thumbnail in pixels.
const THUMB_MAX_HEIGHT = 200;
const THUMB_MAX_WIDTH = 200;
// Thumbnail prefix added to file names.
const THUMB_PREFIX = 'thumb_';
const USER_PROFILE_PREFIX = 'userProfile_';

/**
 * When an image is uploaded in the Storage bucket We generate a thumbnail automatically using
 * ImageMagick.
 * After the thumbnail has been generated and uploaded to Cloud Storage,
 * we write the public URL to the Firebase Realtime Database.
 */
export const onPhotoUploaded_generatePhotoThumbnail = functions.storage
    .object()
    .onChange(photo => {

        const object = photo.data; // The Storage object.
        console.log(`A file ${object.name} was uploaded to ${object.bucket}:`);
        console.log(JSON.stringify(object));

        // File and directory paths.
        const filePath = photo.data.name;
        const contentType = photo.data.contentType; // This is the image Mimme type
        const fileDir = path.dirname(filePath);
        const fileName = path.basename(filePath);
        const thumbFilePath = path.normalize(path.join(fileDir, `${THUMB_PREFIX}${fileName}`));
        const tempLocalFile = path.join(os.tmpdir(), filePath);
        const tempLocalDir = path.dirname(tempLocalFile);
        const tempLocalThumbFile = path.join(os.tmpdir(), thumbFilePath);

        // Exit if this is a move or deletion event.
        if (photo.data.resourceState === 'not_exists') {
            console.log('This is a deletion event.');
            return null;
        }

        // Exit if this is triggered on a file that is not an image.
        if (!contentType.startsWith('image/')) {
            console.log('This is not an image.');
            return null;
        }

        // Exit if the image is user profile.
        if (fileName.startsWith(USER_PROFILE_PREFIX)) {
            console.log('This is User profile photo - NO Thumbnail is needed');
            return null;
        }

        // Exit if the image is already a thumbnail.
        if (fileName.startsWith(THUMB_PREFIX)) {
            console.log('Already a Thumbnail.');
            console.log(`Make Thumbnail ${fileName} public:`);

            // Cloud Storage files.
            const bucket = gcs.bucket(photo.data.bucket);
            //make the thumbnail public
            bucket.file(fileName)
                .makePublic()
                .then(() => {
                    console.log(`gs://${photo.data.bucket}/${fileName} is now public!`);
                })
                .catch(err => {
                    console.error('ERROR:', err);
                });

            return null;
        }


        // Cloud Storage files.
        const bucket = gcs.bucket(photo.data.bucket);
        const file = bucket.file(filePath);
        const thumbFile = bucket.file(thumbFilePath);
        const metadata = {contentType: contentType};

        // Create the temp directory where the storage file will be downloaded.
        return mkdirp(tempLocalDir).then(() => {
            // Download file from bucket.
            return file.download({destination: tempLocalFile});
        }).then(() => {
            console.log('The file has been downloaded to', tempLocalFile);
            // Generate a thumbnail using ImageMagick.
            return spawn('convert', [tempLocalFile, '-thumbnail', `${THUMB_MAX_WIDTH}x${THUMB_MAX_HEIGHT}>`, tempLocalThumbFile], {capture: ['stdout', 'stderr']});
        }).then(() => {
            console.log('Thumbnail created at', tempLocalThumbFile);
            // Uploading the Thumbnail.
            return bucket.upload(tempLocalThumbFile, {destination: thumbFilePath, metadata: metadata});
        }).then(() => {
            console.log('Thumbnail uploaded to Storage at', thumbFilePath);
            // Once the image has been uploaded delete the local files to free up disk space.
            fs.unlinkSync(tempLocalFile);
            fs.unlinkSync(tempLocalThumbFile);
            // Get the Signed URLs for the thumbnail and original image.
            const config = {
                action: 'read',
                expires: '03-01-2500'
            };
            return Promise.all([
                thumbFile.getSignedUrl(config),
                file.getSignedUrl(config)
            ]);
        }).then(results => {
            console.log('Got Signed URLs.');
            console.log(JSON.stringify(results));
            const photoName = object.name.replace('.png', '');
            const fileNameSplit = photoName.split(']');
            const eventKey = fileNameSplit[0];
            const userKey = fileNameSplit[1];
            const photoKey = fileNameSplit[2];
            const thumbResult = results[0];
            const originalResult = results[1];
            const thumbFileUrl = thumbResult[0];
            const fileUrl = originalResult[0];
            // Add the URLs to the Database
            return admin.database()
                .ref(`thumbnailMapper/${eventKey}`)
                .child(photoKey)
                .set({
                    photoKey: photoKey,
                    photoName: photoName,
                    userKey: userKey,
                    eventKey: eventKey,
                    orgFileURL: fileUrl,
                    thumbnailURL: thumbFileUrl,
                    creationDate: (new Date()).toString()
                });
        }).then(() => console.log('Thumbnail URLs saved to database.'));
    });

export const onPhotoAdded_updateThumbnailURL = functions.database
    .ref('thumbnailMapper/{eventKey}/{photoKey}')
    .onCreate(async tm => {

        console.log(`A Photo record was saved to database (updating URLs):`);
        console.log(JSON.stringify(tm));

        //extract relevant data and add log
        const fbData: FBData = extractData(tm);
        console.log(fbData);

        const entity = {
            fileURL: fbData.data.orgFileURL,
            fileThumbnailURL: fbData.data.thumbnailURL
        };
        console.log(`Update the Photo record URLs from Mapper:`);
        console.log(entity);

        // writing to the Firebase Realtime Database.
        await admin.database()
            .ref(`photoToEvent/${fbData.data.eventKey}`)
            .child(fbData.data.photoKey)
            .update(entity).then(p=>{
                console.log(`photo object was updated!`);
                console.log(JSON.stringify(p));
            });

        return entity;
    });
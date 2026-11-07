# Access reviews (example library)

An example of a shared procedure library (docs/LIBRARIES.md): two processes (the second is a sub-process of the
first – the library pins its version at install), a monitor (installed disabled) and a record type. The monitor
names its platform by the reference `idp`; the reviewer maps it to a Microsoft Graph platform when installing.

This release is signed with a **test key** (`../TEST-PUBLISHER-KEY.pub`, publisher `example-publisher`). No
installation trusts it by default. To try the library on a test installation, an administrator adds the publisher
`example-publisher` with that key under Settings → Libraries, then uploads a `.zip` of this folder
(`npm run library -- pack examples/libraries/example-access-reviews -o example.zip`).

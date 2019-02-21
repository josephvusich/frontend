import url from 'url'
import { createEngagementLink, resolveUserName, optOutHtml, optOutText } from './components/helpers'

export default (assignee, notificationId, settingType, caseTitle, caseId, updateWhat, user) => ({
  subject: `Case updated "${caseTitle}"`,
  html: `<img src="cid:logo@unee-t.com"/>

<p>Hi ${resolveUserName(assignee)},</p>

<p>The case <strong>${caseTitle}</strong> has had a ${updateWhat} made by ${resolveUserName(user)}.</p>

<p>Please follow <a href='${
  createEngagementLink({
    url: url.resolve(process.env.ROOT_URL, `/case/${caseId}`),
    id: notificationId,
    email: assignee.emails[0].address
  })
  }'>${url.resolve(process.env.ROOT_URL, `/case/${caseId}`)}</a> to participate.</p>

  ` + optOutHtml(settingType, notificationId, assignee),
  text: `

Hi ${resolveUserName(assignee)},

  ${caseTitle} has has a ${updateWhat} made by ${resolveUserName(user)}.

  Please follow ${
  createEngagementLink({
    url: url.resolve(process.env.ROOT_URL, `/case/${caseId}`),
    id: notificationId,
    email: assignee.emails[0].address
  })
  } to participate.

  ` + optOutText(settingType, notificationId, assignee),
  attachments: [{
    path: 'https://media.dev.unee-t.com/2019-02-21/logo.hmlet.png',
    cid: 'logo@unee-t.com'
  }]
})

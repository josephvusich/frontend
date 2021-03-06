import { Mongo } from 'meteor/mongo'
import { Meteor } from 'meteor/meteor'
import { Email } from 'meteor/email'
import { Accounts } from 'meteor/accounts-base'
import { check } from 'meteor/check'
import { HTTP } from 'meteor/http'
import { Random } from 'meteor/random'
import randToken from 'rand-token'
import { addUserToRole } from './units'
import { findOrCreateUser } from './custom-users'
import UnitMetaData from './unit-meta-data'
import PendingInvitations, { KEEP_DEFAULT, REMOVE_USER } from './pending-invitations'
import unitUserInvitedTemplate from '../email-templates/unit-user-invited'
import { logger } from '../util/logger'

export const collectionName = 'unitRolesData'
export const possibleRoles = [
  {
    name: 'Tenant',
    canBeOccupant: true
  },
  {
    name: 'Owner/Landlord',
    canBeOccupant: true
  },
  {
    name: 'Contractor'
  },
  {
    name: 'Management Company'
  },
  {
    name: 'Agent'
  }
]

const UnitRolesData = new Mongo.Collection(collectionName)

const roleDocMemberMatcher = memberId => roleDoc => roleDoc.members.find(member => member.id === memberId)

Meteor.methods({
  [`${collectionName}.addNewMember`] (firstName, lastName, email, roleType, isOccupant, unitBzId) {
    check(firstName, String)
    check(lastName, String)
    check(email, String)
    check(roleType, String)
    check(isOccupant, Boolean)
    check(unitBzId, Number)
    if (!Meteor.userId()) throw new Meteor.Error('not-authorized')

    if (Meteor.isServer) {
      const unitRoles = UnitRolesData.find({ unitBzId }).fetch()

      // Validating current user's permission to add
      const invitorRole = unitRoles.find(roleDocMemberMatcher(Meteor.userId()))
      if (!invitorRole) throw new Meteor.Error('You are not listed as role holder in this unit')

      // Checking if a user exists for this email, create a new one if he isn't
      const inviteeUser = findOrCreateUser(email)

      // Checking if the invitee already has a role (can happen if an existing user was found in the previous step)
      const isInviteeAlreadyAdded = unitRoles.find(roleDocMemberMatcher(inviteeUser._id))
      if (isInviteeAlreadyAdded) {
        throw new Meteor.Error(
          'The invited user already has a role in this unit. A user can have only one role in a unit'
        )
      }

      // Using first/last name even for an existing user, if not defined yet
      if (!inviteeUser.profile.name) {
        Meteor.users.update({
          _id: inviteeUser._id
        }, {
          $set: {
            'profile.name': `${firstName} ${lastName}`,
            'profile.firstName': firstName,
            'profile.lastName': lastName
          }
        })
      }
      const invitingUser = Meteor.user()
      addUserToRole(invitingUser, inviteeUser, unitBzId, roleType, KEEP_DEFAULT, isOccupant, {
        method: `${collectionName}.addNewMember`,
        user: Meteor.userId(),
        args: [firstName, lastName, email, roleType, isOccupant, unitBzId]
      }, true)

      // Creating an invitation token for invitee access
      const accessToken = randToken.generate(24)
      Meteor.users.update({
        _id: inviteeUser._id,
        'receivedInvites.unitId': unitBzId
      }, {
        $set: {
          'receivedInvites.$.accessToken': accessToken
        }
      })
      const unitMetaData = UnitMetaData.findOne({ bzId: unitBzId })
      const unitTitle = unitMetaData.displayName || unitMetaData.bzName
      const unitDescription = unitMetaData.moreInfo

      Email.send({
        ...unitUserInvitedTemplate({
          invitor: Meteor.user(),
          invitee: invitingUser,
          inviteeRoleType: roleType,
          invitorRoleType: invitorRole.roleType,
          unitTitle,
          unitDescription,
          accessToken
        }),
        to: inviteeUser.emails[0].address,
        from: process.env.FROM_EMAIL
      })
    }
  },
  [`${collectionName}.removeMember`] (email, unitBzId) {
    check(email, String)
    check(unitBzId, Number)
    if (!Meteor.userId()) throw new Meteor.Error('not-authorized')

    if (Meteor.isServer) {
      const unitRoles = UnitRolesData.find({ unitBzId }).fetch()
      if (unitRoles.length === 0) throw new Meteor.Error('The specified unit doesn\'t exists, or not properly imported from BZ')

      // Validating current user's permission to add
      const removerRole = unitRoles.find(roleDocMemberMatcher(Meteor.userId()))
      if (!removerRole) throw new Meteor.Error('You are not listed as a role holder in this unit')

      const userToRemove = Accounts.findUserByEmail(email)
      const toRemoveRole = unitRoles.find(roleDocMemberMatcher(userToRemove._id))
      if (!toRemoveRole) throw new Meteor.Error('The specified user is not listed as role holder in this unit')

      // Extra check to avoid critical future usability issues
      const unitOwners = UnitMetaData.findOne({ bzId: unitBzId }, { ownerIds: 1 }).ownerIds
      if (!unitOwners.includes(Meteor.userId())) {
        throw new Meteor.Error('You can\'t remove users from the unit if you\'re not an owner of this unit')
      }

      const { invitationId } = userToRemove.receivedInvites.find(i => i.unitId === unitBzId)

      const invitationObj = {
        invitedBy: Meteor.user().bugzillaCreds.id,
        invitee: userToRemove.bugzillaCreds.id,
        type: REMOVE_USER,
        unitId: unitBzId,
        role: toRemoveRole.roleType,
        isOccupant: toRemoveRole.members.find(mem => mem.id === userToRemove._id).isOccupant,
        _id: Random.id()
      }

      // Adding to the user to a role on BZ using lambda
      try {
        HTTP.call('POST', process.env.INVITE_LAMBDA_URL, {
          data: [invitationObj],
          headers: {
            Authorization: `Bearer ${process.env.API_ACCESS_TOKEN}`
          }
        })
      } catch (e) {
        logger.error({
          method: `${collectionName}.removeMember`,
          user: Meteor.userId(),
          args: [email, unitBzId],
          step: 'INVITE lambda request',
          error: e
        })
        throw new Meteor.Error('Invite API Lambda error', e)
      }

      // Removing the user's received invite
      Meteor.users.update({ _id: userToRemove._id }, {
        $pull: {
          receivedInvites: {
            invitationId: invitationId
          }
        }
      })

      // Removing the invitation document
      PendingInvitations.remove({ _id: invitationId })

      // Removing the user from the unit's owners list if it was included
      if (unitOwners.includes(userToRemove._id)) {
        UnitMetaData.update({ bzId: unitBzId }, {
          ownerIds: userToRemove._id
        })
      }

      // Removing the user from the role's members list
      const modifierObj = {
        $pull: {
          members: {
            id: userToRemove._id
          }
        }
      }

      // Resetting the default assignee id if the uninvited user was it
      if (toRemoveRole.defaultAssigneeId === userToRemove._id) {
        Object.assign(modifierObj, {
          $set: {
            defaultAssigneeId: -1
          }
        })
      }

      // Executing the update query
      UnitRolesData.update({ _id: toRemoveRole._id }, modifierObj)
    }
  }
})

export default UnitRolesData

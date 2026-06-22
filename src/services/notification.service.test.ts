import prisma from '../config/database';
import { NotificationService } from './notification.service';
import { sendNotification, sendUnreadNotificationCountUpdate } from '../websocket/socket.server';
import { NotificationStatus, NotificationType } from '@prisma/client';

jest.mock('../config/database');
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn(),
  })),
}));
jest.mock('../websocket/socket.server', () => ({
  sendNotification: jest.fn(),
  sendUnreadNotificationCountUpdate: jest.fn(),
}));
jest.mock('@prisma/client', () => ({
  NotificationStatus: {
    UNREAD: 'UNREAD',
    READ: 'READ',
  },
  NotificationType: {
    SYSTEM_ALERT: 'SYSTEM_ALERT',
  },
}));

describe('NotificationService unread count socket updates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('emits a new notification and unread count update when creating a notification', async () => {
    const notification = {
      id: 'notification-1',
      userId: 'user-1',
      status: NotificationStatus.UNREAD,
    };

    (prisma.notification.create as jest.Mock).mockResolvedValue(notification);
    (prisma.notification.count as jest.Mock).mockResolvedValue(4);

    const result = await NotificationService.createNotification(
      'user-1',
      NotificationType.SYSTEM_ALERT,
      'System alert',
      'Message'
    );

    expect(result).toBe(notification);
    expect(sendNotification).toHaveBeenCalledWith('user-1', notification);
    expect(prisma.notification.count).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        status: NotificationStatus.UNREAD,
      },
    });
    expect(sendUnreadNotificationCountUpdate).toHaveBeenCalledWith('user-1', {
      userId: 'user-1',
      unreadCount: 4,
      reason: 'created',
      notificationId: 'notification-1',
    });
  });

  it('emits an unread count update when marking a notification read', async () => {
    (prisma.notification.findUnique as jest.Mock).mockResolvedValue({
      id: 'notification-1',
      userId: 'user-1',
      status: NotificationStatus.UNREAD,
    });
    (prisma.notification.update as jest.Mock).mockResolvedValue({
      id: 'notification-1',
      userId: 'user-1',
      status: NotificationStatus.READ,
    });
    (prisma.notification.count as jest.Mock).mockResolvedValue(2);

    await NotificationService.markAsRead('notification-1', 'user-1');

    expect(sendUnreadNotificationCountUpdate).toHaveBeenCalledWith('user-1', {
      userId: 'user-1',
      unreadCount: 2,
      reason: 'marked_read',
      notificationId: 'notification-1',
    });
  });

  it('does not emit unread count updates for unrelated users', async () => {
    (prisma.notification.findUnique as jest.Mock).mockResolvedValue({
      id: 'notification-1',
      userId: 'user-2',
      status: NotificationStatus.UNREAD,
    });

    await expect(NotificationService.markAsRead('notification-1', 'user-1')).rejects.toThrow(
      'You do not have permission to update this notification'
    );

    expect(prisma.notification.update).not.toHaveBeenCalled();
    expect(sendUnreadNotificationCountUpdate).not.toHaveBeenCalled();
  });

  it('emits an unread count update when bulk marking notifications read', async () => {
    (prisma.notification.updateMany as jest.Mock).mockResolvedValue({ count: 3 });
    (prisma.notification.count as jest.Mock).mockResolvedValue(0);

    await NotificationService.markAllAsRead('user-1');

    expect(sendUnreadNotificationCountUpdate).toHaveBeenCalledWith('user-1', {
      userId: 'user-1',
      unreadCount: 0,
      reason: 'bulk_marked_read',
    });
  });

  it('emits an unread count update when deleting an unread notification', async () => {
    (prisma.notification.findUnique as jest.Mock).mockResolvedValue({
      id: 'notification-1',
      userId: 'user-1',
      status: NotificationStatus.UNREAD,
    });
    (prisma.notification.delete as jest.Mock).mockResolvedValue({});
    (prisma.notification.count as jest.Mock).mockResolvedValue(1);

    await NotificationService.deleteNotification('notification-1', 'user-1');

    expect(sendUnreadNotificationCountUpdate).toHaveBeenCalledWith('user-1', {
      userId: 'user-1',
      unreadCount: 1,
      reason: 'deleted',
      notificationId: 'notification-1',
    });
  });

  it('does not emit an unread count update when deleting an already-read notification', async () => {
    (prisma.notification.findUnique as jest.Mock).mockResolvedValue({
      id: 'notification-1',
      userId: 'user-1',
      status: NotificationStatus.READ,
    });
    (prisma.notification.delete as jest.Mock).mockResolvedValue({});

    await NotificationService.deleteNotification('notification-1', 'user-1');

    expect(sendUnreadNotificationCountUpdate).not.toHaveBeenCalled();
  });
});

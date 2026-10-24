import com.rabbitmq.client.ConnectionFactory;

import java.nio.charset.StandardCharsets;

public class OfferProducer {
    public static void main(String[] args) throws Exception {
        var factory = new ConnectionFactory();
        factory.setHost(System.getenv().getOrDefault("RABBITMQ_HOST", "localhost"));
        factory.setUsername("lesson");
        factory.setPassword("lesson");

        try (var connection = factory.newConnection();
                var channel = connection.createChannel()) {
            // Создаём общую очередь для всех исполнителей
            channel.queueDeclare("lesson-driver-offers", true, false, false, null);

            // Включаем подтверждения приёма сообщений брокером
            channel.confirmSelect();
            byte[] payload = "offer-42".getBytes(StandardCharsets.UTF_8);

            // Пустое имя exchange направляет сообщение в очередь по её имени
            channel.basicPublish("", "lesson-driver-offers", null, payload);
            channel.waitForConfirmsOrDie(5000);
        }
    }
}
